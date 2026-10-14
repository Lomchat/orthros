// ID3DXEffect::SetRawValue(h, data, offset, bytes) on the JIT's deferred queue (runtime.js DEFER_RAW): queued with a copy
// of its `bytes` bytes taken at the call (a later write to the source changes nothing), the data argument pointing at
// the copy; a byte count that is not whole words or past DEFER_RAW_MAX, a null data pointer, or a name instead of a
// handle go to JavaScript at once. Vm.drainDeferred then runs the handler on the record: the same arguments and bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, THUNK_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { Vm } from '../src/core/vm.js';
import { DEFER_QUEUE, DEFER_RAW_MAX, COM_MARKER, FX_OWNER } from '../src/cpu/jit/runtime.js';

const CODE = 0x20000000, SLOT = 0x10000100, OBJ = 0x10004000, HB = 0x10005000, DATA = 0x10006000, NAME = 0x10002000, IDX = 5, THUNK_SIZE = 16;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const push = (v) => [0x68, ...le(v)];
const setRaw = (h, data, off, bytes) => [...push(bytes), ...push(off), ...push(data), ...push(h), ...push(OBJ), 0xff, 0x15, ...le(SLOT)];

test('SetRawValue: queued with a copy of its bytes, odd sizes / big sizes / null data / names to JavaScript; drained with the same arguments and bytes', () => {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  const calls = [[HB + 8, DATA, 4, 12], [HB + 8, DATA, 0, 6], [HB + 12, DATA, 0, DEFER_RAW_MAX + 4], [HB + 12, 0, 0, 8], [NAME, DATA, 0, 8], [HB + 16, DATA + 16, 8, DEFER_RAW_MAX]];
  mem.writeBytes(CODE, Uint8Array.from([...calls.flatMap((a) => setRaw(...a)), 0xf4]));
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true });
  jit.cpu = cpu;
  jit.markFast(IDX, 'com.dll!ID3DXEffect::SetRawValue', true);
  mem.write32(SLOT, THUNK_BASE + IDX * THUNK_SIZE);
  mem.write32(OBJ + 12, HB); mem.write32(OBJ + 4, COM_MARKER); mem.write32(HB + FX_OWNER, OBJ); // (a live effect: its block names it)
  for (let i = 0; i < 300; i++) mem.write32(DATA + 4 * i, 0x1000 + i);
  cpu.eip = CODE; cpu.esp = 0x10009000; cpu.eflags = F.RESERVED1 | F.IF;
  const toJs = [];
  let r;
  for (let n = 0; n < 100; n++) {
    r = jit.run({ maxInsns: 1e6 });
    if (r !== EXIT.THUNK) break;
    toJs.push([1, 2, 3, 4].map((i) => mem.read32(cpu.esp + 4 + 4 * i)));
    cpu.eip = mem.read32(cpu.esp); cpu.esp += 24; cpu.eax = 0;
  }
  assert.equal(r, EXIT.HALT);
  assert.equal(cpu.esp, 0x10009000, 'stdcall returns');
  assert.deepEqual(toJs, [calls[1], calls[2], calls[3], calls[4]], 'the other four leave');
  for (let i = 0; i < 300; i++) mem.write32(DATA + 4 * i, 0xdead); // (written after the calls: the copies keep the values of the call)

  // drained: the handler sees the record's arguments, the data argument pointing at the copy
  const seen = [];
  const def = { fn: (c) => { const [h, data, off, bytes] = [1, 2, 3, 4].map((i) => c.arg(i)); seen.push([c.arg(0), h, off, bytes, Array.from({ length: bytes >>> 2 }, (_, i) => mem.read32(data + 4 * i))]); return 0; } };
  const fake = { mem, ctx: { mem, arg(i) { return mem.read32(this.sp + 4 + 4 * i); } }, apiHistCounts: null, api: { thunks: { [IDX]: { def } } }, proc: {}, apiCalls: 0, d3dDevices: null };
  Vm.prototype.drainDeferred.call(fake, { cpu });
  assert.equal(mem.read32(DEFER_QUEUE), 0, 'queue emptied');
  assert.deepEqual(seen, [
    [OBJ, HB + 8, 4, 12, [0x1000, 0x1001, 0x1002]],
    [OBJ, HB + 16, 8, DEFER_RAW_MAX, Array.from({ length: DEFER_RAW_MAX / 4 }, (_, i) => 0x1004 + i)],
  ]);
});
