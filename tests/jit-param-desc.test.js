// ID3DXEffect::GetParameterDesc on the dispatcher's fast path (runtime.js FID_PARAM_DESC): the JavaScript handler keeps
// the description of a parameter asked by handle in the effect's cache (after its handle block); the next calls with
// that handle are answered from there without leaving the translated code — the same 44 bytes — while a handle not
// cached, a name, a null output pointer or a handle given again to another parameter go to JavaScript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory, THUNK_BASE } from '../src/cpu/memory.js';
import { CpuState, THREAD_STATES_BASE, EXIT, F } from '../src/cpu/state.js';
import { Interp } from '../src/cpu/interp.js';
import { Jit } from '../src/cpu/jit/jit.js';
import { setup } from './fx-env.js';
import { COM_MARKER } from '../src/cpu/jit/runtime.js';

const CODE = 0x20000000, SLOT = 0x20001000, IDX = 7, THUNK_SIZE = 16;
const le = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
const push = (v) => [0x68, ...le(v)];

test('GetParameterDesc: answered from the effect\'s cache once JavaScript described the handle, else JavaScript', () => {
  const mem = new GuestMemory();
  const { fx, fxPtr, ctx, name } = setup(mem);
  mem.write32(fxPtr + 4, COM_MARKER); // (as com.js writes it: a live Orthros object)
  const hA = fx.GetParameterByName(ctx(fxPtr, 0, name('A'))), hB = fx.GetParameterByName(ctx(fxPtr, 0, name('B')));
  const OUT1 = 0x20002000, OUT2 = 0x20002100, NAMEB = name('B');
  // the JavaScript handler's description of A (filling the cache)
  assert.equal(fx.GetParameterDesc(ctx(fxPtr, hA, OUT1)) ?? 0, 0);
  const want = mem.bytes(OUT1, 44).slice();
  const calls = [[hA, OUT2], [hB, OUT2], [NAMEB, OUT2], [hA, 0]];
  mem.writeBytes(CODE, Uint8Array.from([...calls.flatMap(([h, out]) => [...push(out), ...push(h), ...push(fxPtr), 0xff, 0x15, ...le(SLOT)]), 0xf4]));
  const cpu = new CpuState(mem, THREAD_STATES_BASE);
  cpu.reset();
  const jit = new Jit(mem, new Interp(mem, cpu), { smc: true });
  jit.cpu = cpu;
  jit.markFast(IDX, 'com.dll!ID3DXEffect::GetParameterDesc', true);
  mem.write32(SLOT, THUNK_BASE + IDX * THUNK_SIZE);
  cpu.eip = CODE; cpu.esp = 0x10f09000; cpu.eflags = F.RESERVED1 | F.IF;
  const toJs = [];
  let r;
  for (let n = 0; n < 20; n++) {
    r = jit.run({ maxInsns: 1e6 });
    if (r !== EXIT.THUNK) break;
    toJs.push([mem.read32(cpu.esp + 8), mem.read32(cpu.esp + 12)]);
    cpu.eip = mem.read32(cpu.esp); cpu.esp += 16; cpu.eax = 0;
  }
  assert.equal(r, EXIT.HALT);
  assert.equal(cpu.esp, 0x10f09000, 'stdcall returns');
  assert.deepEqual(toJs, [[hB, OUT2], [NAMEB, OUT2], [hA, 0]], 'only the cached handle with an output stays in WASM');
  assert.deepEqual(mem.bytes(OUT2, 44), want, 'the handler\'s description');
  assert.equal(cpu.eax, 0);

  // a handle given again (the block wraps around): its cache entry is dropped
  const e = fx.descEntry(hA);
  assert.equal(mem.read32(e), hA);
  fx.nextHandle = (hA - fx.handleBlock) / 4; // (the next handle handed out is hA's)
  fx.handleOf({ kind: 'param' });
  assert.equal(mem.read32(e), 0, 'forgotten');
});
