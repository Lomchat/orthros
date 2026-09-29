// ReadFile on a file whose data arrives asynchronously (vm.asyncReads, the HTTP backend's prepare()): the guest sees the
// same results as with synchronous reads, and a thread parked on such a read does not hold up a thread waiting for it
// inside a callback (a nested wait, during which no promise can settle).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { RealClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';

const EXE = new URL('../build/pe/asyncread.exe', import.meta.url).pathname;
const SIZE = 200000, PIECE = 65536, DELAY = 150;

/** A network-like backend: a piece not fetched yet is fetched synchronously by read(), or asynchronously by prepare(). */
class NetBackend extends MemBackend {
  constructor(data) { super(); this.here = new Set(); this.stats = { sync: 0, async: 0 }; this.data = data; }
  stat(rel) { return rel.toLowerCase() === 'data.bin' ? { size: SIZE, isDir: false, mtime: 0 } : super.stat(rel); }
  open(rel) {
    if (rel.toLowerCase() !== 'data.bin') return null;
    const b = this;
    const pieces = (off, len) => { const out = []; const end = Math.min(off + len, SIZE); for (let p = Math.floor(off / PIECE); p * PIECE < end; p++) out.push(p); return off >= end ? [] : out; };
    return {
      size: () => SIZE,
      prepare(off, len) {
        const miss = pieces(off, len).filter((p) => !b.here.has(p));
        if (!miss.length) return null;
        b.stats.async++;
        return new Promise((res) => setTimeout(() => { for (const p of miss) b.here.add(p); res(); }, DELAY));
      },
      read(off, len) {
        const miss = pieces(off, len).filter((p) => !b.here.has(p));
        if (miss.length) { b.stats.sync++; for (const p of miss) b.here.add(p); }
        const end = Math.min(off + len, SIZE);
        return off >= end ? new Uint8Array(0) : b.data.slice(off, end);
      },
      write: () => 0, truncate() {}, close() {},
    };
  }
}

async function runExe(asyncReads) {
  const data = new Uint8Array(SIZE); for (let i = 0; i < SIZE; i++) data[i] = (i * 7 + (i >> 8)) & 0xff;
  const vfs = new Vfs();
  const test = new MemBackend();
  const net = new NetBackend(data);
  vfs.mount('C:\\', new MemBackend());
  vfs.mount('C:\\Test', test);
  vfs.mount('C:\\Net', net);
  test.open('asyncread.exe', { create: true }).write(0, fs.readFileSync(EXE));
  const clock = new RealClock();
  const host = new HeadlessHost({ clock, width: 320, height: 200 });
  host.cooperative = true;
  const vm = new Vm({ vfs, clock, host, logKinds: ['warn', 'crash'] });
  vm.asyncReads = asyncReads;
  vm.createProcess({ exePath: 'C:\\Test\\asyncread.exe' });
  let code;
  for (;;) { // (the browser worker's pump: runFor, then back to the event loop)
    const r = vm.runFor(performance.now() + 20);
    if (r.state === 'exited') { code = r.code; break; }
    await new Promise((res) => {
      const t = setTimeout(res, r.state === 'sleep' ? Math.max(0, r.until - performance.now()) : r.state === 'idle' ? 5 : 0);
      host.wake = () => { clearTimeout(t); res(); };
    });
  }
  return { code, out: vm.stdout.join(''), stats: net.stats };
}

test('asynchronous ReadFile: the synchronous path\'s results (pointer, OVERLAPPED, EOF), no stall under a nested wait', { skip: !fs.existsSync(EXE) && 'build/pe/asyncread.exe missing (make pe-tests)' }, async () => {
  const want = await runExe(false);
  assert.equal(want.code, 0, want.out);
  assert.equal(want.stats.async, 0);
  assert.match(want.out, /^read 0: ret=1 got=16 sum=\d+ ptr=16\n/);
  assert.match(want.out, /read 1: ret=1 got=100 sum=\d+ ptr=70100 err=0\n/);
  assert.match(want.out, /read 2: ret=1 got=40 sum=\d+ ptr=200000\n/);
  assert.match(want.out, /read 3: ret=0 got=0 sum=0 err=38\n/);
  assert.match(want.out, /ovl: 0 100 70000\n/);
  assert.match(want.out, /nested wait=0 got=64 sum=\d+ quick=1\n/);
  const got = await runExe(true);
  // (reads 0-2 and the late read park; the late one is woken by the nested wait and fetches synchronously)
  assert.deepEqual(got.stats, { sync: 1, async: 4 });
  assert.equal(got.out, want.out);
  assert.equal(got.code, 0);
});
