// DirectShow filter graph (src/win32/quartz.js) through its COM methods called directly: interface pointers handed out
// by QueryInterface after another interface of the same graph was released (its memory reused by the next object).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Vm } from '../src/core/vm.js';
import { Vfs, MemBackend } from '../src/vfs/vfs.js';
import { VirtualClock } from '../src/core/clock.js';
import { HeadlessHost } from '../src/host/display.js';
import { Ctx } from '../src/win32/ctx.js';
import { writeGuid } from '../src/win32/com.js';

const PE_DIR = new URL('../build/pe/', import.meta.url).pathname;
const skip = !fs.existsSync(PE_DIR + 'quartz.exe') && 'build/pe/quartz.exe missing (make pe-tests)';
const IID = {
  IGraphBuilder: '56a868a9-0ad4-11ce-b03a-0020af0ba770', IMediaControl: '56a868b1-0ad4-11ce-b03a-0020af0ba770',
  IMediaEventEx: '56a868c0-0ad4-11ce-b03a-0020af0ba770', IVideoWindow: '56a868b4-0ad4-11ce-b03a-0020af0ba770',
  IMediaSeeking: '36b73880-c2c8-11cf-8b46-00805f6cef60', IBasicAudio: '56a868b3-0ad4-11ce-b03a-0020af0ba770',
};

function setup() {
  const vfs = new Vfs(), dir = new MemBackend();
  vfs.mount('C:\\', new MemBackend()); vfs.mount('C:\\Test', dir);
  dir.open('quartz.exe', { create: true }).write(0, fs.readFileSync(PE_DIR + 'quartz.exe'));
  dir.open('movie.mpg', { create: true }).write(0, fs.readFileSync(new URL('./fixtures/media/movie.mpg', import.meta.url).pathname));
  const clock = new VirtualClock();
  const host = new HeadlessHost({ clock, width: 640, height: 480 });
  const vm = new Vm({ vfs, clock, host, logKinds: ['crash'] });
  vm.createProcess({ exePath: 'C:\\Test\\quartz.exe' });
  const heap = vm.proc.processHeap, mem = vm.mem;
  const stack = heap.alloc(256), out = heap.alloc(16), guid = heap.alloc(16);
  /** method `index` of the interface pointer `ptr` with 32-bit arguments */
  const call = (ptr, index, ...args) => {
    mem.write32(stack, 0); mem.write32(stack + 4, ptr);
    args.forEach((a, i) => mem.write32(stack + 8 + 4 * i, a >>> 0));
    const c = new Ctx(vm); c.thread = vm.proc.threads[0]; c.sp = stack; c.proc = vm.proc;
    const obj = vm.com.objectAt(ptr);
    return vm.com.dispatch(c, obj.iface, index) >>> 0;
  };
  const qi = (ptr, iid) => { writeGuid(mem, guid, iid); mem.write32(out, 0); const hr = call(ptr, 0, guid, out); return { hr, p: mem.read32(out) }; };
  const iface = (ptr) => vm.com.objectAt(ptr)?.iface.name;
  return { vm, call, qi, iface, heap, mem };
}

test('quartz: an interface asked again after its release is a new object of that interface, not whatever reused its memory', { skip }, () => {
  const { vm, call, qi, iface } = setup();
  const c = new Ctx(vm); c.proc = vm.proc; c.thread = vm.proc.threads[0];
  const gb = vm.com.classes.get('e436ebb3-524f-11ce-9f53-0020af0ba770')(c, IID.IGraphBuilder);
  for (const [first, second] of [['IMediaControl', 'IVideoWindow'], ['IMediaEventEx', 'IMediaSeeking'], ['IBasicAudio', 'IMediaControl']]) {
    const a = qi(gb, IID[first]); assert.equal(a.hr, 0);
    assert.equal(call(a.p, 2), 0, `${first} released`);
    const b = qi(gb, IID[second]); assert.equal(b.hr, 0); assert.equal(iface(b.p), second);
    const again = qi(gb, IID[first]); assert.equal(again.hr, 0);
    assert.equal(iface(again.p), first, `QueryInterface(${first}) after its release answered with ${iface(again.p)}`);
    assert.notEqual(again.p, b.p);
    call(b.p, 2); call(again.p, 2);
  }
  // the graph lives while any of its interfaces does
  assert.equal(call(gb, 2), 0);
});

test('quartz: WaitForCompletion of a graph whose file could not be read on returns EC_ERRORABORT instead of waiting forever', { skip }, () => {
  const { vm, call, qi, heap, mem } = setup();
  const c = new Ctx(vm); c.proc = vm.proc; c.thread = vm.proc.threads[0];
  const gb = vm.com.classes.get('e436ebb3-524f-11ce-9f53-0020af0ba770')(c, IID.IGraphBuilder);
  const name = heap.alloc(64); mem.writeWString(name, 'C:\\Test\\movie.mpg', 32);
  assert.equal(call(gb, 13, name, 0), 0, 'RenderFile');
  const mc = qi(gb, IID.IMediaControl).p, me = qi(gb, IID.IMediaEventEx).p;
  assert.equal(call(mc, 7), 0, 'Run');
  vm.com.objectAt(gb).impl.g.player.fail(); // (as a failed read of the file does: movie-player.js tick)
  const code = heap.alloc(4); mem.write32(code, 0x55);
  assert.equal(call(me, 9, 0xffffffff, code), 0, 'WaitForCompletion(INFINITE)');
  assert.equal(mem.read32(code), 3, 'EC_ERRORABORT');
  call(mc, 2); call(me, 2); call(gb, 2);
});
