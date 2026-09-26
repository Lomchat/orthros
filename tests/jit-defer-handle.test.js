// Deferred COM calls given a handle (runtime.js DEFER_HANDLE — the D3DX effect parameter setters): queued by the
// dispatcher's fast path only when the handle lies in the handle block the object keeps at +12; a parameter name
// (a string the game may overwrite before the queue runs) or any other value goes to JavaScript at once. The queued
// record holds the arguments and a copy of the vector taken at the call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, THUNK_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { DEFER_QUEUE, DEFER_HANDLE_BYTES } from '../src/cpu/jit/runtime.js';

const CODE = 0x20000000, SLOT = 0x10000100, OBJ = 0x10004000, HB = 0x10005000, VEC = 0x10006000, NAME = 0x10002000, IDX = 5, THUNK_SIZE = 16;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const push = (v) => [0x68, ...le(v)];
const setVector = (h) => [...push(VEC), ...push(h), ...push(OBJ), 0xff, 0x15, ...le(SLOT)]; // effect->SetVector(h, &vec)

test('effect setters: queued with a handle of the object, left to JavaScript with a name or a foreign value', () => {
  const mem = new GuestMemory();
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  mem.writeBytes(CODE, Uint8Array.from([...setVector(HB + 8), ...setVector(NAME), ...setVector(HB + DEFER_HANDLE_BYTES), ...setVector(HB + DEFER_HANDLE_BYTES - 4), 0xf4]));
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true });
  jit.cpu = cpu;
  jit.markFast(IDX, 'com.dll!ID3DXEffect::SetVector', true);
  mem.write32(SLOT, THUNK_BASE + IDX * THUNK_SIZE);
  mem.write32(OBJ + 12, HB);
  [1.5, -2, 3.25, 4].forEach((v, i) => mem.writeF32(VEC + 4 * i, v));
  mem.writeCString(NAME, 'g_color');
  cpu.eip = CODE; cpu.esp = 0x10009000; cpu.eflags = F.RESERVED1 | F.IF;
  const toJs = [];
  let r;
  for (let n = 0; n < 100; n++) {
    r = jit.run({ maxInsns: 1e6 });
    if (r !== EXIT.THUNK) break;
    toJs.push(mem.read32(cpu.esp + 8)); // (the handle; the JavaScript handler's part: stdcall return)
    cpu.eip = mem.read32(cpu.esp); cpu.esp += 16; cpu.eax = 0;
  }
  assert.equal(r, EXIT.HALT);
  assert.deepEqual(toJs, [NAME, HB + DEFER_HANDLE_BYTES], 'a name and a value past the block leave');
  assert.equal(cpu.esp, 0x10009000, 'stdcall returns');
  const bytes = mem.read32(DEFER_QUEUE), rec = (k) => DEFER_QUEUE + 16 + k * 36;
  assert.equal(bytes, 2 * 36, 'two records: thunk, argc, 3 arguments, the vector');
  for (const [k, h] of [[0, HB + 8], [1, HB + DEFER_HANDLE_BYTES - 4]]) {
    const p = rec(k);
    assert.deepEqual([mem.read32(p), mem.read32(p + 4), mem.read32(p + 8), mem.read32(p + 12), mem.read32(p + 16)], [IDX, 3, OBJ, h, p + 20]);
    assert.deepEqual([0, 1, 2, 3].map((i) => mem.readF32(p + 20 + 4 * i)), [1.5, -2, 3.25, 4]);
  }
});
