// JIT runtime module: the WASM-side dispatcher loop (EIP -> translated block via a hash table
// in guest memory), the lazy-flag materialization helper and small numeric helpers. Built once
// per Jit instance with the same emitter used for translated regions.
import { ModuleBuilder, Code, T } from './wasm.js';
import { ST, EXIT, F } from '../state.js';
import { THUNK_BASE, THUNK_END, THUNK_SIZE, JIT_HASH_BASE, JIT_HASH_BITS, JIT_SCRATCH_BASE, MUTEX_HANDLES, MUTEX_HANDLE_END } from '../memory.js';
import { addExpKernels } from './fpmath-exp.js';
import { addTrigKernels } from './fpmath-trig.js';
import { addAtanKernels } from './fpmath-atan.js';
import { addNanKernels } from './fpmath-nan.js';
import { addRoundKernels } from './fpmath-round.js';
import { emitD3dxFast, D3DX_FAST_FIRST, D3DX_FAST_LAST, D3DX_F64_LOCALS } from './fast-d3dx.js';

/**
 * Transcendental kernels of the runtime module, in the order the region modules import them
 * (translate.js IMP_* constants follow this list after flags/round24/fallback): name -> [params, results].
 */
export const MATH_KERNELS = Object.freeze([
  ['exp2m1', [T.f64], [T.f64]], // 2^x - 1 (F2XM1)
  ['log2', [T.f64], [T.f64]], // log2 x (FYL2X)
  ['log2p1', [T.f64], [T.f64]], // log2(1 + x) (FYL2XP1)
  ['scalb', [T.f64, T.f64], [T.f64]], // a 2^trunc(b) with the interpreter's FSCALE special cases
  ['sin', [T.f64], [T.f64]], // FSIN / FSINCOS
  ['cos', [T.f64], [T.f64]], // FCOS / FSINCOS
  ['tan', [T.f64], [T.f64]], // FPTAN
  ['atan2', [T.f64, T.f64], [T.f64]], // atan2(y, x) (FPATAN: y = ST(1), x = ST(0))
  ['sincos', [T.f64], [T.f64, T.f64]], // (sin x, cos x) from one range reduction (FSINCOS)
  ['nan2', [T.f64, T.f64], [T.f64, T.i32]], // x87 NaN-operand rule: (result, raise IE) (fpmath-nan.js)
  ['arith24', [T.f64, T.f64, T.i32, T.i32], [T.f64]], // exact PC=24 rounding of an operation (fpmath-round.js)
  ['f32rc', [T.f64, T.i32], [T.f32]], // FST m32 under a directed rounding mode (fpmath-round.js)
]);

export const EXIT_TRANSLATE = 7;
/** a region specialized for one x87 precision/rounding mode was entered under another (see Jit.run) */
export const EXIT_FPUMODE = 8;
/** run the instruction at EIP in the interpreter, then continue (a rare case left to the reference, see Emitter.stepExit) */
export const EXIT_STEP = 9;
export const HASH_ENTRY = 16; // eip u32, fnIdx u32, block u32, pad
export const HASH_PROBES = 4;
// Region function signature: (block, state, eax, ecx, edx, ebx, esp, ebp, esi, edi, eflags,
// lzop, lzres, lza, lzb, fs) -> nextEip|0. The parameters double as the region's locals 0..15
// (see translate.js), so a region can hand its live register file to the next one with a tail
// call (region chaining) without going through the state block.
export const REGION_PARAMS = Object.freeze(Array(16).fill(T.i32));
export const REGION_RESULTS = Object.freeze([T.i32]);
/** State-block offsets of the 14 register/flag arguments that follow (block, state). */
export const REGION_ARG_OFFSETS = Object.freeze([...Array.from({ length: 8 }, (_, i) => ST.GPR + 4 * i), ST.EFLAGS, ST.LZ_OP, ST.LZ_RES, ST.LZ_SRC1, ST.LZ_SRC2, ST.ICOUNT]); // (the budget as the last parameter: see translate.js L_ICOUNT)

/** Does this engine accept `return_call_indirect` (WASM tail calls)? Region chaining needs it. */
export function supportsReturnCall() {
  try {
    const m = new ModuleBuilder();
    m.importTable('env', 'table', 1, undefined);
    const t = m.type([T.i32], [T.i32]);
    const c = new Code();
    c.get(0).i32(0).return_call_indirect(t, 0);
    m.func([T.i32], [T.i32], [], c, 'f');
    return WebAssembly.validate(m.build());
  } catch { return false; }
}
/**
 * chain(target, state, registers / flags / budget as the region parameters after the block) -> next EIP | 0: the exit
 * of a region translated with opts.chainStub (its x87 / XMM caches already written back), shared by many regions: when
 * the target is translated, not an API thunk nor the stop address and the budget is left, tail-call its region (the
 * block from the hash entry) with the values received; otherwise write them to the state block and return the target
 * to the dispatcher. The same checks and probe sequence as translate.js emitChain, in one place instead of in every
 * region: the code a transition runs stays in the instruction cache (the translated code of a game in play is many
 * times the size of the caches, and region exits are where it is entered and left).
 */
function chainStubCode(regionType, countChains, tailCalls = true) {
  const c = new Code();
  const TGT = 0, STATE = 1, ICOUNT = 15, E = 16;
  const noChain = c.block();
  // (an engine without tail calls: the module must still validate — the JIT then never chains, see Jit — so the stub
  // only writes the state back and returns the target)
  if (!tailCalls) c.br(noChain);
  else {
    c.get(ICOUNT).i32(0).le_s().br_if(noChain);
    c.get(TGT).i32(THUNK_BASE).sub().i32(THUNK_END - THUNK_BASE).lt_u().br_if(noChain);
    c.get(TGT).get(STATE).i32load(ST.STOP_AT).eq().br_if(noChain);
    c.get(TGT).eqz().br_if(noChain);
    const found = c.block();
    c.get(TGT).i32(0x9e3779b1 | 0).mul().i32(32 - JIT_HASH_BITS).shr_u().set(E + 1);
    for (let p = 0; p < HASH_PROBES; p++) {
      c.get(E + 1); if (p) c.i32(p).add();
      c.i32((1 << JIT_HASH_BITS) - 1).and().i32(HASH_ENTRY).mul().i32(JIT_HASH_BASE).add().tee(E);
      c.i32load(0).get(TGT).eq();
      if (p === 0) c.hint(true);
      c.br_if(found);
    }
    c.br(noChain);
    c.end(); // found
    c.get(STATE).get(TGT).i32store(ST.EIP);
    if (countChains) c.get(STATE).get(STATE).i32load(ST.TRANSITIONS).i32(1).add().i32store(ST.TRANSITIONS);
    c.get(E).i32load(8);
    for (let i = STATE; i <= ICOUNT; i++) c.get(i);
    c.get(E).i32load(4).return_call_indirect(regionType, 0);
  }
  c.end(); // noChain
  REGION_ARG_OFFSETS.forEach((off, k) => c.get(STATE).get(2 + k).i32store(off));
  c.get(STATE).get(TGT).i32store(ST.EIP);
  c.get(TGT);
  return c;
}

// Fast-path API table: one byte per thunk index (id of a WASM implementation, 0 = none), and a
// small block of per-process constants used by those implementations.
export const FAST_TABLE = JIT_SCRATCH_BASE;
export const PROC_CONSTS = JIT_SCRATCH_BASE + 0x10000; // +0 process heap handle, +4 non-zero: the bindings' filter off (DEFER_F_TEX / STREAM / IB; measurement)
/**
 * Deferred COM calls: state setters of the Direct3D devices (they always succeed and their effect is
 * only observable through other device calls) are recorded by the WASM fast path in a queue in guest
 * memory and return D3D_OK at once; the VM runs the queued calls, in order, before any API call handled
 * in JavaScript (Vm.drainDeferred). DEFER_SPEC[thunk] = argc (stack arguments, `this` included) |
 * pointer argument index << 4 | words of the structure it points to << 8 (copied into the record,
 * the argument then points at the copy) | DEFER_HANDLE; records: thunk index, argc, arguments, structure.
 * DEFER_HANDLE: the first argument after `this` must be one of the object's handles — within the
 * DEFER_HANDLE_BYTES block whose address the object keeps at +12 (com.js) — anything else (a D3DX
 * parameter name, whose string may be gone by the time the call runs) goes to JavaScript at once.
 * DEFER_OBJ: queued only while the object keeps a non-zero word at +12 (an effect clears it while the application's
 * state manager receives its states: applying them then calls guest code, which must run at the call, on its thread).
 * Both flags also require that word to be non-zero.
 */
export const FID_DEFER = 16;
export const DEFER_HANDLE = 1 << 16, DEFER_HANDLE_BYTES = 4 * 4096, DEFER_OBJ = 1 << 17;
/**
 * ID3DXEffect::GetParameterDesc on the fast path (FID_PARAM_DESC): after its handle block (+12) an effect keeps a
 * direct-mapped cache of PARAM_DESC_SLOTS descriptions by handle — [handle, the 44-byte D3DXPARAMETER_DESC] — filled by
 * the JavaScript handler (a parameter's description never changes); a handle found there is answered by a copy
 */
export const FID_PARAM_DESC = 27, PARAM_DESC_SLOTS = 64, PARAM_DESC_ENTRY = 48, PARAM_DESC_BYTES = PARAM_DESC_SLOTS * PARAM_DESC_ENTRY;
/**
 * ID3DXEffect's technique calls on the deferred queue (with DEFER_HANDLE / DEFER_OBJ): after its description cache an
 * effect keeps FX_SLOT_BYTES (from FX_SLOTS past its handle block) — +0 the pass count of its technique as of every call
 * issued so far (0: none, or a technique without passes: JavaScript answers), +4 the restore list of its open Begin
 * ([shadow block, count, entries], as COMMIT_LIST; 0: none) — and the word at each technique's handle holds its pass
 * count (0 at every other handle). DEFER_TECH (SetTechnique): the handle's word must be non-zero, and becomes +0.
 * DEFER_BEGIN (Begin): +0 must be non-zero; it is written at once where the pass-count pointer points (when given), and
 * the record's pointer cleared (the handler, run later, must not write there again). DEFER_END (End, with
 * DEFER_STATES): the shadow entries its restore may set are +4's list, taken (+4 cleared); none: the filter off until
 * the queue has run.
 */
export const DEFER_TECH = 1 << 27, DEFER_BEGIN = 1 << 28, DEFER_END = 1 << 29;
export const FX_SLOTS = DEFER_HANDLE_BYTES + PARAM_DESC_BYTES, FX_SLOT_BYTES = 8;
/**
 * Issued-state filter of the device state setters (render, texture stage, sampler states): a device keeps at +12 the
 * address of a STATE_SHADOW block — +0 enabled (0 while a state block records: every set is then recorded), entries of
 * two words (known, value) from +16: SHADOW_RS render states 0..255, SHADOW_TSS stage 0..7 x type 0..39, SHADOW_SAMP
 * sampler 0..15 x type 0..15. An entry holds the state's value as of every call issued so far, queued ones included: the
 * fast path writes it when it queues a set, and the device's state tables (state-table.js) whenever JavaScript changes
 * the state (a drained call writes what the fast path wrote, in queue order). A set to the value the entry holds is
 * then a no-op of the handler (redundant sets return D3D_OK without effect) and the fast path returns at once.
 */
export const DEFER_F_RS = 1 << 18, DEFER_F_TSS = 1 << 19, DEFER_F_SAMP = 1 << 20;
/**
 * The same filter for the Direct3D 9 bindings (a set of what is bound already changes nothing, references included):
 * SHADOW_TEX texture of stages 0..15, SHADOW_STREAM stream 0..15 x (buffer, offset, stride), SHADOW_IB the index buffer —
 * kept by the device (Device8.syncRefShadow and its setters) and forgotten by a queued effect commit that may bind them
 */
export const DEFER_F_TEX = 1 << 24, DEFER_F_STREAM = 1 << 25, DEFER_F_IB = 1 << 26;
export const DEFER_F_ANY = DEFER_F_RS | DEFER_F_TSS | DEFER_F_SAMP | DEFER_F_TEX | DEFER_F_STREAM | DEFER_F_IB;
/** a queued call that may change COM reference counts (binding a texture, a buffer; an effect pass applying them) */
export const DEFER_REFS = 1 << 21;
/**
 * a queued call that may change device states (an effect's CommitChanges applying its pass): the shadow entries listed
 * by the object's commit list (+20: COMMIT_LIST) are forgotten when it is queued — [shadow block, count, entry
 * indices], count 0xffffffff: any — else (no list) the filter is off until the queue has run
 */
export const DEFER_STATES = 1 << 22;
export const COMMIT_LIST = 20;
/**
 * a queued call whose structure is `bytes` (the argument after the pointer's: index 4, D3DX SetRawValue(h, data, offset,
 * bytes)) long: copied after the arguments as for a fixed structure, up to DEFER_RAW_MAX bytes in whole words (others,
 * and a null pointer, go to JavaScript at once)
 */
export const DEFER_RAW = 1 << 23, DEFER_RAW_MAX = 1024;
export const SHADOW_RS = 0, SHADOW_TSS = 256, SHADOW_SAMP = SHADOW_TSS + 8 * 40, SHADOW_TEX = SHADOW_SAMP + 16 * 16, SHADOW_STREAM = SHADOW_TEX + 16, SHADOW_IB = SHADOW_STREAM + 3 * 16, SHADOW_ENTRIES = SHADOW_IB + 1, SHADOW_BYTES = 16 + 8 * SHADOW_ENTRIES;
export const COMMIT_LIST_WORDS = 2 + SHADOW_ENTRIES;
/** Orthros COM objects (com.js): +4 this marker, +16 the reference count (AddRef/Release on the fast path), +20 an effect's commit list */
export const COM_MARKER = 0x4d4f4321, COM_REFS = 16;
export const FID_ADDREF = 21, FID_RELEASE = 22;
/** GetTickCount's fast path (timeGetTime's is 19: they step differently, core/timer-res.js) */
export const FID_TICKCOUNT = 28;
export const DEFER_SPEC = JIT_SCRATCH_BASE + 0x20000;
/** +0 bytes used, +4 nonzero when a queued record may change reference counts (DEFER_REFS), +8 nonzero when one may
 * change device states (DEFER_STATES), records from +16 */
export const DEFER_QUEUE = JIT_SCRATCH_BASE + 0x60000;
/** profiling runtime: calls handled by the fast path, u32 per fast API id; at +0x80 a count, at +0x100 a ring of the
 * last 1024 return addresses (the call sites) */
export const FAST_PROF = JIT_SCRATCH_BASE + 0xa8100;
/** always counted: +0 sets dropped by the issued-state filter, +4 AddRef/Release done by the fast path */
export const FAST_STATS = FAST_PROF + 0x1200;
export const DEFER_CAP = 0x3fff0;
const deferSpecs = (iface, list, flags = 0) => Object.fromEntries(list.map(([m, argc, ptr = 15, words = 0]) => [`${iface}::${m}`, argc | (ptr << 4) | (words << 8) | flags]));
export const DEFER_SPECS = {
  ...deferSpecs('IDirect3DDevice9', [['SetRenderState', 3]], DEFER_F_RS),
  ...deferSpecs('IDirect3DDevice9', [['SetTextureStageState', 4]], DEFER_F_TSS),
  ...deferSpecs('IDirect3DDevice9', [['SetSamplerState', 4]], DEFER_F_SAMP),
  ...deferSpecs('IDirect3DDevice9', [['SetTransform', 3, 2, 16], ['SetLight', 3, 2, 26], ['LightEnable', 3],
    ['SetMaterial', 2, 1, 17], ['SetFVF', 2], ['SetVertexShader', 2], ['SetPixelShader', 2], ['SetVertexDeclaration', 2],
    ['SetViewport', 2, 1, 6], ['SetScissorRect', 2, 1, 4], ['SetSoftwareVertexProcessing', 2]]),
  ...deferSpecs('IDirect3DDevice9', [['SetStreamSource', 5]], DEFER_REFS | DEFER_F_STREAM),
  ...deferSpecs('IDirect3DDevice9', [['SetIndices', 2]], DEFER_REFS | DEFER_F_IB),
  ...deferSpecs('IDirect3DDevice9', [['SetTexture', 3]], DEFER_REFS | DEFER_F_TEX),
  ...deferSpecs('IDirect3DDevice8', [['SetRenderState', 3]], DEFER_F_RS),
  ...deferSpecs('IDirect3DDevice8', [['SetTextureStageState', 4]], DEFER_F_TSS),
  ...deferSpecs('IDirect3DDevice8', [['SetTransform', 3, 2, 16], ['SetLight', 3, 2, 26], ['LightEnable', 3], ['SetMaterial', 2, 1, 17],
    ['SetVertexShader', 2], ['SetPixelShader', 2], ['SetViewport', 2, 1, 6]]),
  ...deferSpecs('IDirect3DDevice8', [['SetStreamSource', 4], ['SetIndices', 3], ['SetTexture', 3]], DEFER_REFS),
  // effect parameter setters: only effect calls observe the values (and a texture set here is released by JavaScript calls)
  ...deferSpecs('ID3DXEffect', [['SetBool', 3], ['SetInt', 3], ['SetFloat', 3], ['SetVector', 3, 2, 4], ['SetMatrix', 3, 2, 16], ['SetMatrixTranspose', 3, 2, 16]], DEFER_HANDLE),
  ...deferSpecs('ID3DXEffect', [['SetTexture', 3]], DEFER_HANDLE | DEFER_REFS),
  ...deferSpecs('ID3DXEffect', [['SetRawValue', 5, 2, 0]], DEFER_HANDLE | DEFER_RAW),
  // the pass's states set again from the parameters (only device calls observe them; always D3D_OK), the pass closed
  ...deferSpecs('ID3DXEffect', [['CommitChanges', 1]], DEFER_OBJ | DEFER_REFS | DEFER_STATES),
  ...deferSpecs('ID3DXEffect', [['EndPass', 1]], DEFER_OBJ),
  // the technique set, a technique begun (its pass count answered at once, the device states saved when the queue runs),
  // ended (the states restored: they may change device states and reference counts)
  ...deferSpecs('ID3DXEffect', [['SetTechnique', 2]], DEFER_HANDLE | DEFER_TECH),
  ...deferSpecs('ID3DXEffect', [['Begin', 3]], DEFER_OBJ | DEFER_BEGIN),
  ...deferSpecs('ID3DXEffect', [['End', 1]], DEFER_OBJ | DEFER_REFS | DEFER_STATES | DEFER_END),
};
export const FAST = Object.freeze({ GetLastError: 1, SetLastError: 2, TlsGetValue: 3, TlsSetValue: 4, EnterCriticalSection: 5, LeaveCriticalSection: 6, TryEnterCriticalSection: 7, InterlockedIncrement: 8, InterlockedDecrement: 9, InterlockedExchange: 10, InterlockedExchangeAdd: 11, InterlockedCompareExchange: 12, GetCurrentThreadId: 13, GetCurrentProcessId: 14, GetProcessHeap: 15, WaitForSingleObject: 17, ReleaseMutex: 18, timeGetTime: 19, QueryPerformanceCounter: 20 });
export const FAST_NAMES = { 'kernel32.dll!GetLastError': 1, 'kernel32.dll!SetLastError': 2, 'kernel32.dll!TlsGetValue': 3, 'kernel32.dll!FlsGetValue': 3, 'kernel32.dll!TlsSetValue': 4, 'kernel32.dll!FlsSetValue': 4, 'kernel32.dll!EnterCriticalSection': 5, 'kernel32.dll!LeaveCriticalSection': 6, 'kernel32.dll!TryEnterCriticalSection': 7, 'kernel32.dll!InterlockedIncrement': 8, 'kernel32.dll!InterlockedDecrement': 9, 'kernel32.dll!InterlockedExchange': 10, 'kernel32.dll!InterlockedExchangeAdd': 11, 'kernel32.dll!InterlockedCompareExchange': 12, 'kernel32.dll!GetCurrentThreadId': 13, 'kernel32.dll!GetCurrentProcessId': 14, 'kernel32.dll!GetProcessHeap': 15, 'kernel32.dll!WaitForSingleObject': 17, 'kernel32.dll!ReleaseMutex': 18,
  'winmm.dll!timeGetTime': 19, 'kernel32.dll!GetTickCount': 28, 'kernel32.dll!QueryPerformanceCounter': 20, 'com.dll!ID3DXEffect::GetParameterDesc': 27 };
/** the tick count of timeGetTime/GetTickCount at the VM clock's origin (kernel32.js, misc-dlls.js: the same value) */
export const TICK_BASE = 0x1000000;

// Lazy flag op kinds (kind << 2 | sizeLog2)
// ADC/SBB keep (res, a, b): the carry-in is res - a - b (a - b - res), so no fourth value is needed
export const LZ = Object.freeze({ NONE: 0, ADD: 1, SUB: 2, LOGIC: 3, INC: 4, DEC: 5, NEG: 6, SHL: 7, SHR: 8, SAR: 9, MUL: 10, IMUL: 11, SHLD: 12, BSF: 13, ADC: 14, SBB: 15 });

/** JS mirror of the WASM flags helper (used when leaving WASM with lazy state pending). */
export function materializeFlags(op, res, a, b, ef) {
  const kind = op >> 2, sz = op & 3;
  const bits = 8 << sz, mask = bits === 32 ? 0xffffffff : (1 << bits) - 1, sign = (1 << (bits - 1)) >>> 0;
  res = (res & mask) >>> 0; a = (a & mask) >>> 0; b = (b & mask) >>> 0;
  let cf = 0, of = 0, af = 0;
  switch (kind) {
    case LZ.ADD: cf = res < a ? 1 : 0; of = ((a ^ res) & (b ^ res) & sign) ? 1 : 0; af = (a ^ b ^ res) & 0x10 ? 1 : 0; break;
    case LZ.SUB: cf = a < b ? 1 : 0; of = ((a ^ b) & (a ^ res) & sign) ? 1 : 0; af = (a ^ b ^ res) & 0x10 ? 1 : 0; break;
    case LZ.ADC: { const cin = ((res - a - b) & mask) !== 0; cf = (cin ? res <= a : res < a) ? 1 : 0; of = ((a ^ res) & (b ^ res) & sign) ? 1 : 0; af = (a ^ b ^ res) & 0x10 ? 1 : 0; break; }
    case LZ.SBB: { const cin = ((a - b - res) & mask) !== 0; cf = (cin ? a <= b : a < b) ? 1 : 0; of = ((a ^ b) & (a ^ res) & sign) ? 1 : 0; af = (a ^ b ^ res) & 0x10 ? 1 : 0; break; }
    case LZ.LOGIC: break;
    case LZ.INC: cf = b & 1; of = res === sign ? 1 : 0; af = (res & 0xf) === 0 ? 1 : 0; break;
    case LZ.DEC: cf = b & 1; of = res === (sign - 1) >>> 0 ? 1 : 0; af = (res & 0xf) === 0xf ? 1 : 0; break;
    case LZ.NEG: cf = a !== 0 ? 1 : 0; of = a === sign ? 1 : 0; af = (a & 0xf) !== 0 ? 1 : 0; break;
    case LZ.SHL: cf = b <= bits ? (b === bits ? a & 1 : (a >>> (bits - b)) & 1) : 0; of = (((res & sign) ? 1 : 0) ^ cf); break;
    case LZ.SHR: cf = (a >>> (b - 1)) & 1; of = (a & sign) ? 1 : 0; break;
    case LZ.SAR: cf = (a >>> (b - 1)) & 1; of = 0; break;
    case LZ.MUL: cf = of = a !== 0 ? 1 : 0; break;
    case LZ.IMUL: cf = of = b & 1; break;
    case LZ.SHLD: cf = a & 1; of = b & 1; break;
    case LZ.BSF: break;
    default: return ef >>> 0;
  }
  let f = ef & ~(F.CF | F.PF | F.AF | F.ZF | F.SF | F.OF);
  if (cf) f |= F.CF; if (of) f |= F.OF; if (af) f |= F.AF;
  if (res === 0) f |= F.ZF; if (res & sign) f |= F.SF;
  let p = res & 0xff; p ^= p >> 4; p ^= p >> 2; p ^= p >> 1; if (!(p & 1)) f |= F.PF;
  if (kind === LZ.BSF) { f = (f & ~F.ZF) | (a ? F.ZF : 0); }
  return f >>> 0;
}

/**
 * Build the runtime module bytes. Imports: env.memory, env.table.
 * Exports: run(eip, state) -> exit code (halts at ST.STOP_AT); flags(op,res,a,b,ef) -> ef;
 * round24(x, rc) -> x'; the transcendental kernels of MATH_KERNELS (pure WASM, fpmath-*.js).
 */
export function buildRuntime(opts = {}) {
  const m = new ModuleBuilder();
  m.importMemory('env', 'memory', 32768, 32768, !!opts.shared);
  m.importTable('env', 'table', 1024, undefined);
  const nowIdx = m.importFunc('env', 'now', [], [T.f64]); // (the VM clock in ms: the time APIs' fast path)
  // (timeGetTime's and GetTickCount's milliseconds: the VM clock at the last clock interrupt / tick, core/timer-res.js)
  const mmTimeIdx = m.importFunc('env', 'mmTime', [], [T.f64]), tickCountIdx = m.importFunc('env', 'tickCount', [], [T.f64]);
  const regionType = m.type(REGION_PARAMS, REGION_RESULTS);

  // ---- transcendental kernels (x87 F2XM1/FYL2X/FYL2XP1/FSCALE/FSIN/FCOS/FSINCOS/FPTAN/FPATAN):
  // defined here once, imported by every region module like round24 (WASM -> WASM, D004)
  {
    const k = { ...addExpKernels(m), ...addTrigKernels(m), ...addAtanKernels(m), ...addNanKernels(m), ...addRoundKernels(m) };
    for (const [name] of MATH_KERNELS) m.exportFunc(name, k[name]);
  }

  // ---- flags(op, res, a, b, ef) -> ef
  {
    const c = new Code();
    // params: 0 op, 1 res, 2 a, 3 b, 4 ef ; locals: 5 kind, 6 bits, 7 sign, 8 f, 9 tmp, 10 mask
    const [OP, RES, A, B, EF, KIND, BITS, SIGN, FL, TMP, MASK] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    c.get(OP).i32(2).shr_u().set(KIND);
    c.i32(8).get(OP).i32(3).and().shl().set(BITS); // bits = 8 << sz
    c.i32(1).get(BITS).i32(1).sub().shl().set(SIGN);
    // mask = bits==32 ? -1 : (1<<bits)-1
    c.get(SIGN).i32(1).shl().i32(1).sub().set(MASK); // (sign<<1)-1 works for 32 too (wraps to -1)
    c.get(RES).get(MASK).and().set(RES); c.get(A).get(MASK).and().set(A); c.get(B).get(MASK).and().set(B);
    // f = ef & ~0x8d5
    c.get(EF).i32(~0x8d5).and().set(FL);
    // ZF
    c.get(RES).eqz(); const ifz = c.if_(); c.get(FL).i32(F.ZF).or().set(FL); c.end(); void ifz;
    // SF
    c.get(RES).get(SIGN).and(); const ifs = c.if_(); c.get(FL).i32(F.SF).or().set(FL); c.end(); void ifs;
    // PF: popcnt(res & 0xff) even
    c.get(RES).i32(0xff).and().popcnt().i32(1).and().eqz(); const ifp = c.if_(); c.get(FL).i32(F.PF).or().set(FL); c.end(); void ifp;
    // kind switch: compute cf/of/af into TMP bits (bit0=cf, bit1=of, bit2=af)
    const kinds = 16;
    const done = c.block();
    const labels = [];
    for (let k = 0; k < kinds; k++) labels.push(c.block());
    c.get(KIND).br_table(labels, done);
    // reverse order: label[0] closes first -> code for kind 0
    const setCF = () => { c.get(FL).i32(F.CF).or().set(FL); };
    const setOF = () => { c.get(FL).i32(F.OF).or().set(FL); };
    const setAF = () => { c.get(FL).i32(F.AF).or().set(FL); };
    const afFromXor = () => { c.get(A).get(B).xor().get(RES).xor().i32(0x10).and(); const i = c.if_(); setAF(); c.end(); void i; };
    for (let i = 0; i < kinds; i++) {
      const k = kinds - 1 - i; // the i-th `end` closes the innermost remaining block = labels[kinds-1-i]
      c.end(); // enter code for kind k
      switch (k) {
        case LZ.NONE: break;
        case LZ.ADD: { c.get(RES).get(A).lt_u(); const i = c.if_(); setCF(); c.end(); void i; c.get(A).get(RES).xor().get(B).get(RES).xor().and().get(SIGN).and(); const j = c.if_(); setOF(); c.end(); void j; afFromXor(); break; }
        case LZ.SUB: { c.get(A).get(B).lt_u(); const i = c.if_(); setCF(); c.end(); void i; c.get(A).get(B).xor().get(A).get(RES).xor().and().get(SIGN).and(); const j = c.if_(); setOF(); c.end(); void j; afFromXor(); break; }
        case LZ.LOGIC: break;
        case LZ.INC: { c.get(B).i32(1).and(); const i = c.if_(); setCF(); c.end(); void i; c.get(RES).get(SIGN).eq(); const j = c.if_(); setOF(); c.end(); void j; c.get(RES).i32(0xf).and().eqz(); const l = c.if_(); setAF(); c.end(); void l; break; }
        case LZ.DEC: { c.get(B).i32(1).and(); const i = c.if_(); setCF(); c.end(); void i; c.get(RES).get(SIGN).i32(1).sub().eq(); const j = c.if_(); setOF(); c.end(); void j; c.get(RES).i32(0xf).and().i32(0xf).eq(); const l = c.if_(); setAF(); c.end(); void l; break; }
        case LZ.NEG: { c.get(A); const i = c.if_(); setCF(); c.end(); void i; c.get(A).get(SIGN).eq(); const j = c.if_(); setOF(); c.end(); void j; c.get(A).i32(0xf).and(); const l = c.if_(); setAF(); c.end(); void l; break; }
        case LZ.SHL: {
          // cf = b<=bits ? (b==bits ? a&1 : (a >> (bits-b)) & 1) : 0
          c.get(B).get(BITS).le_u(); const i = c.if_(T.i32);
          c.get(B).get(BITS).eq(); const i2 = c.if_(T.i32); c.get(A).i32(1).and(); c.else_(); c.get(A).get(BITS).get(B).sub().shr_u().i32(1).and(); c.end(); void i2;
          c.else_(); c.i32(0); c.end(); void i;
          c.set(TMP);
          c.get(TMP); const i3 = c.if_(); setCF(); c.end(); void i3;
          c.get(RES).get(SIGN).and().i32(0).ne().get(TMP).xor(); const i4 = c.if_(); setOF(); c.end(); void i4;
          break;
        }
        case LZ.SHR: { c.get(A).get(B).i32(1).sub().shr_u().i32(1).and(); const i = c.if_(); setCF(); c.end(); void i; c.get(A).get(SIGN).and(); const j = c.if_(); setOF(); c.end(); void j; break; }
        case LZ.SAR: { c.get(A).get(B).i32(1).sub().shr_u().i32(1).and(); const i = c.if_(); setCF(); c.end(); void i; break; }
        case LZ.MUL: { c.get(A); const i = c.if_(); setCF(); setOF(); c.end(); void i; break; }
        case LZ.IMUL: { c.get(B).i32(1).and(); const i = c.if_(); setCF(); setOF(); c.end(); void i; break; }
        case LZ.SHLD: { c.get(A).i32(1).and(); const i = c.if_(); setCF(); c.end(); void i; c.get(B).i32(1).and(); const j = c.if_(); setOF(); c.end(); void j; break; }
        case LZ.BSF: { c.get(FL).i32(~F.ZF).and().set(FL); c.get(A); const i = c.if_(); c.get(FL).i32(F.ZF).or().set(FL); c.end(); void i; break; }
        case LZ.ADC: case LZ.SBB: {
          // carry-in = (res - a - b) & mask (ADC) / (a - b - res) & mask (SBB); CF = cin ? x <=u y : x <u y
          if (k === LZ.ADC) c.get(RES).get(A).sub().get(B).sub(); else c.get(A).get(B).sub().get(RES).sub();
          c.get(MASK).and();
          if (k === LZ.ADC) { const i = c.if_(T.i32); c.get(RES).get(A).le_u(); c.else_(); c.get(RES).get(A).lt_u(); c.end(); void i; }
          else { const i = c.if_(T.i32); c.get(A).get(B).le_u(); c.else_(); c.get(A).get(B).lt_u(); c.end(); void i; }
          const i = c.if_(); setCF(); c.end(); void i;
          if (k === LZ.ADC) c.get(A).get(RES).xor().get(B).get(RES).xor().and().get(SIGN).and(); else c.get(A).get(B).xor().get(A).get(RES).xor().and().get(SIGN).and();
          const j = c.if_(); setOF(); c.end(); void j;
          afFromXor(); break;
        }
      }
      c.br(done);
    }
    c.end(); // done
    c.get(FL);
    const idx = m.func([T.i32, T.i32, T.i32, T.i32, T.i32], [T.i32], [T.i32, T.i32, T.i32, T.i32, T.i32, T.i32], c, 'flags');
    m.exportFunc('flags', idx);
  }

  // ---- round24(x f64, rc i32) -> f64 : round mantissa to 24 bits keeping the f64 exponent range
  {
    const c = new Code();
    const [X, RC, BITS, LOW, SIGN] = [0, 1, 2, 3, 4];
    c.get(X).i64reinterpret_f64().set(BITS);
    // exponent all ones (inf/nan) -> return x
    c.get(BITS).i64(0x7ff0000000000000n).i64and().i64(0x7ff0000000000000n).i64eq(); const i0 = c.if_(); c.get(X).return_(); c.end(); void i0;
    c.get(BITS).i64(0x1fffffffn).i64and().set(LOW);
    c.get(LOW).i64eqz(); const i1 = c.if_(); c.get(X).return_(); c.end(); void i1;
    c.get(BITS).i64(63n).i64shr_u().wrap().set(SIGN);
    // rc: 0 nearest, 1 down, 2 up, 3 trunc
    const done = c.block();
    const l3 = c.block(), l2 = c.block(), l1 = c.block(), l0 = c.block();
    c.get(RC).br_table([l0, l1, l2, l3], done);
    c.end(); // nearest
    c.get(BITS).i64(0x0fffffffn).i64add().get(BITS).i64(29n).i64shr_u().i64(1n).i64and().i64add().set(BITS); c.br(done);
    c.end(); // down: negative -> away from zero
    c.get(SIGN); const d1 = c.if_(); c.get(BITS).i64(0x20000000n).i64add().set(BITS); c.end(); void d1; c.br(done);
    c.end(); // up: positive -> away from zero
    c.get(SIGN).eqz(); const d2 = c.if_(); c.get(BITS).i64(0x20000000n).i64add().set(BITS); c.end(); void d2; c.br(done);
    c.end(); // trunc: nothing
    c.end(); // done
    c.get(BITS).i64(-0x20000000n).i64and().f64reinterpret_i64();
    const idx = m.func([T.f64, T.i32], [T.f64], [T.i64, T.i64, T.i32], c, 'round24');
    m.exportFunc('round24', idx);
  }

  // ---- fastApi(fid, state) -> 1 if handled (registers/stack updated as a stdcall return), else 0
  let fastApiIdx;
  {
    const c = new Code();
    const [FID, STATE, IDX, SP, TEB, A0, A1, A2, TM, N, P, FB, FE, FV, WD, KC, VP] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    c.get(STATE).i32load(ST.GPR + 16).set(SP);
    c.get(STATE).i32load(ST.FS_BASE).set(TEB);
    c.get(SP).i32load(4).set(A0); c.get(SP).i32load(8).set(A1); c.get(SP).i32load(12).set(A2);
    // stdcall return helper: eax = value on stack, pop return address + argc*4
    const ret = (argc) => { c.i32store(ST.GPR); c.get(STATE).get(SP).i32load(0).i32store(ST.EIP); c.get(STATE).get(SP).i32(4 + 4 * argc).add().i32store(ST.GPR + 16); c.i32(1).return_(); };
    const notHandled = c.block();
    // a call re-executed after a parked wait carries a recorded result for its JavaScript handler
    c.get(STATE).i32load(ST.RESUMING).br_if(notHandled);
    const NF = Math.max(D3DX_FAST_LAST, FID_PARAM_DESC, FID_TICKCOUNT) + 1;
    const labels = new Array(NF);
    for (let i = NF - 1; i >= 0; i--) labels[i] = c.block();
    c.get(FID).br_table(labels, notHandled);
    for (let k = 0; k < NF; k++) {
      c.end();
      switch (k) {
        case 0: c.br(notHandled); break;
        case 1: c.get(STATE).get(TEB).i32load(0x34); ret(0); break; // GetLastError
        case 2: c.get(TEB).get(A0).i32store(0x34); c.get(STATE).i32(0); ret(1); break; // SetLastError
        case 3: // TlsGetValue(i) i<64: last error = 0
          c.get(A0).i32(64).ge_u().br_if(notHandled);
          c.get(TEB).i32(0).i32store(0x34);
          c.get(STATE).get(TEB).get(A0).i32(2).shl().add().i32load(0xe10); ret(1); break;
        case 4: c.get(A0).i32(64).ge_u().br_if(notHandled); c.get(TEB).get(A0).i32(2).shl().add().get(A1).i32store(0xe10); c.get(STATE).i32(1); ret(2); break; // TlsSetValue
        case 5: { // EnterCriticalSection: owner == tid -> recursion; free -> take; else JS
          const own = c.block();
          c.get(A0).i32load(12).get(TEB).i32load(0x24).eq().br_if(own);
          c.get(A0).i32load(4).i32(-1).ne().br_if(notHandled);
          c.get(A0).i32(0).i32store(4); c.get(A0).i32(1).i32store(8); c.get(A0).get(TEB).i32load(0x24).i32store(12); c.get(STATE).i32(0); ret(1);
          c.end(); void own;
          c.get(A0).get(A0).i32load(8).i32(1).add().i32store(8); c.get(A0).get(A0).i32load(4).i32(1).add().i32store(4); c.get(STATE).i32(0); ret(1); break;
        }
        case 6: { // LeaveCriticalSection
          c.get(A0).get(A0).i32load(8).i32(1).sub().tee(TM).i32store(8);
          c.get(A0).get(A0).i32load(4).i32(1).sub().i32store(4);
          c.get(TM).i32(0).le_s(); const i = c.if_(); c.get(A0).i32(0).i32store(12); c.get(A0).i32(-1).i32store(4); c.get(A0).i32(0).i32store(8); c.end(); void i;
          c.get(STATE).i32(0); ret(1); break;
        }
        case 7: { // TryEnterCriticalSection
          const own = c.block(); const fail = c.block();
          c.get(A0).i32load(12).get(TEB).i32load(0x24).eq().br_if(own);
          c.get(A0).i32load(4).i32(-1).ne().br_if(fail);
          c.get(A0).i32(0).i32store(4); c.get(A0).i32(1).i32store(8); c.get(A0).get(TEB).i32load(0x24).i32store(12); c.get(STATE).i32(1); ret(1);
          c.end(); void fail; c.get(STATE).i32(0); ret(1);
          c.end(); void own;
          c.get(A0).get(A0).i32load(8).i32(1).add().i32store(8); c.get(A0).get(A0).i32load(4).i32(1).add().i32store(4); c.get(STATE).i32(1); ret(1); break;
        }
        case 8: c.get(A0).get(A0).i32load(0).i32(1).add().tee(TM).i32store(0); c.get(STATE).get(TM); ret(1); break;
        case 9: c.get(A0).get(A0).i32load(0).i32(1).sub().tee(TM).i32store(0); c.get(STATE).get(TM); ret(1); break;
        case 10: c.get(A0).i32load(0).set(TM); c.get(A0).get(A1).i32store(0); c.get(STATE).get(TM); ret(2); break;
        case 11: c.get(A0).i32load(0).set(TM); c.get(A0).get(TM).get(A1).add().i32store(0); c.get(STATE).get(TM); ret(2); break;
        case 12: { c.get(A0).i32load(0).set(TM); c.get(TM).get(A2).eq(); const i = c.if_(); c.get(A0).get(A1).i32store(0); c.end(); void i; c.get(STATE).get(TM); ret(3); break; }
        case 13: c.get(STATE).get(TEB).i32load(0x24); ret(0); break;
        case 14: c.get(STATE).get(TEB).i32load(0x20); ret(0); break;
        case 15: c.get(STATE).i32(PROC_CONSTS).i32load(0); ret(0); break;
        case FID_DEFER: { // record the call (see DEFER_SPEC): TM = spec, N = argc, P = record address, A0 = size
          c.get(IDX).i32(2).shl().i32load(DEFER_SPEC).set(TM);
          c.get(TM).i32(DEFER_HANDLE | DEFER_OBJ).and();
          const guarded = c.if_(); // (A0 = this, A1 = the handle)
          c.get(A0).i32(0x7fff0000).ge_u().br_if(notHandled);
          c.get(A0).i32load(12).eqz().br_if(notHandled);
          c.get(TM).i32(DEFER_HANDLE).and();
          const handle = c.if_();
          c.get(A1).get(A0).i32load(12).sub().i32(DEFER_HANDLE_BYTES).ge_u().br_if(notHandled);
          c.end(); void handle;
          c.get(TM).i32(DEFER_TECH).and();
          const tech = c.if_(); // (a technique's handle: its word, the pass count, non-zero)
          c.get(A1).i32(3).and().br_if(notHandled);
          c.get(A1).i32load(0).eqz().br_if(notHandled);
          c.end(); void tech;
          c.get(TM).i32(DEFER_BEGIN).and();
          const begin = c.if_(); // (a technique set, a pass-count pointer null or writable)
          c.get(A0).i32load(12).i32load(FX_SLOTS).eqz().br_if(notHandled);
          c.get(A1).i32(0x7fff0000 - 4).ge_u().br_if(notHandled);
          c.end(); void begin;
          c.end(); void guarded;
          c.get(TM).i32(15).and().set(N);
          c.get(TM).i32(8).shr_u().i32(0xff).and().set(WD); // (the structure's words)
          c.get(TM).i32(DEFER_RAW).and();
          const raw = c.if_(); // (WD from the byte count: whole words, a bounded size, a pointer the memory holds)
          c.get(SP).i32load(20).tee(WD).i32(3).and().get(WD).i32(DEFER_RAW_MAX).gt_u().or().br_if(notHandled);
          c.get(SP).i32load(12).tee(FB).eqz().get(FB).i32(0x7fff0000 - DEFER_RAW_MAX).ge_u().or().br_if(notHandled);
          c.get(WD).i32(2).shr_u().set(WD);
          c.end(); void raw;
          { // issued-state filter (DEFER_F_*): FE = the first shadow entry of the state set (0: none), KC entries whose
            // values are the stack words from VP on (a stream source: buffer, offset, stride)
            const nofilter = c.block();
            c.get(TM).i32(DEFER_F_ANY).and().eqz().br_if(nofilter);
            c.get(A0).i32(0x7fff0000).ge_u().br_if(nofilter);
            c.get(A0).i32load(4).i32(COM_MARKER).ne().br_if(nofilter);
            c.get(A0).i32load(12).tee(FB).eqz().br_if(nofilter);
            c.get(FB).i32(0x7fff0000 - SHADOW_BYTES).ge_u().br_if(nofilter);
            c.get(FB).i32load(0).eqz().br_if(nofilter); // (a state block records)
            c.i32(DEFER_QUEUE).i32load(8).br_if(nofilter); // (a queued call changes states the shadow does not follow)
            c.i32(1).set(KC);
            const picked = c.block(); // TEB = the first entry's index
            const kind = (flag, emit) => { c.get(TM).i32(flag).and(); const i = c.if_(); emit(); c.br(picked); c.end(); void i; };
            kind(DEFER_F_RS, () => { c.get(A1).i32(256).ge_u().br_if(nofilter); c.get(A1).i32(SHADOW_RS).add().set(TEB); c.get(SP).i32(12).add().set(VP); });
            kind(DEFER_F_TSS, () => { c.get(A1).i32(8).ge_u().get(A2).i32(40).ge_u().or().br_if(nofilter); c.get(A1).i32(40).mul().get(A2).add().i32(SHADOW_TSS).add().set(TEB); c.get(SP).i32(16).add().set(VP); });
            kind(DEFER_F_SAMP, () => { c.get(A1).i32(16).ge_u().get(A2).i32(16).ge_u().or().br_if(nofilter); c.get(A1).i32(16).mul().get(A2).add().i32(SHADOW_SAMP).add().set(TEB); c.get(SP).i32(16).add().set(VP); });
            kind(DEFER_F_TEX, () => { c.i32(PROC_CONSTS).i32load(4).br_if(nofilter); c.get(A1).i32(16).ge_u().br_if(nofilter); c.get(A1).i32(SHADOW_TEX).add().set(TEB); c.get(SP).i32(12).add().set(VP); });
            kind(DEFER_F_STREAM, () => { c.i32(PROC_CONSTS).i32load(4).br_if(nofilter); c.get(A1).i32(16).ge_u().br_if(nofilter); c.get(A1).i32(3).mul().i32(SHADOW_STREAM).add().set(TEB); c.get(SP).i32(12).add().set(VP); c.i32(3).set(KC); });
            c.i32(PROC_CONSTS).i32load(4).br_if(nofilter); c.i32(SHADOW_IB).set(TEB); c.get(SP).i32(8).add().set(VP); // (DEFER_F_IB)
            c.end(); void picked;
            c.get(FB).get(TEB).i32(3).shl().add().i32(16).add().set(FE); // (TEB reused: the entry index)
            const differs = c.block();
            c.i32(0).set(A2);
            const cmp = c.loop(); // every entry known and holding its value
            c.get(FE).get(A2).i32(3).shl().add().tee(FV).i32load(0).eqz().br_if(differs);
            c.get(FV).i32load(4).get(VP).get(A2).i32(2).shl().add().i32load(0).ne().br_if(differs);
            c.get(A2).i32(1).add().tee(A2).get(KC).lt_u().br_if(cmp);
            c.end(); void cmp;
            // the state already has these values once the queue has run: nothing to do, D3D_OK
            c.i32(FAST_STATS).i32(FAST_STATS).i32load(0).i32(1).add().i32store(0);
            c.get(STATE).i32(0).i32store(ST.GPR); c.get(STATE).get(SP).i32load(0).i32store(ST.EIP);
            c.get(STATE).get(SP).i32(4).add().get(N).i32(2).shl().add().i32store(ST.GPR + 16); c.i32(1).return_();
            c.end(); void differs;
            c.end(); void nofilter;
          }
          c.get(N).get(WD).add().i32(2).add().i32(2).shl().set(A0);
          c.i32(DEFER_QUEUE).i32load(0).tee(A1).get(A0).add().i32(DEFER_CAP).gt_u().br_if(notHandled); // full: JavaScript drains, then handles it
          c.get(A1).i32(DEFER_QUEUE + 16).add().set(P);
          c.get(P).get(IDX).i32store(0); c.get(P).get(N).i32store(4);
          c.i32(0).set(A2);
          const copy = c.block(); const lp = c.loop();
          c.get(A2).get(N).ge_u().br_if(copy);
          c.get(P).get(A2).i32(2).shl().add().get(SP).get(A2).i32(2).shl().add().i32load(4).i32store(8);
          c.get(A2).i32(1).add().set(A2); c.br(lp);
          c.end(); c.end(); void copy;
          // the structure behind the pointer argument, copied after the arguments
          c.get(WD);
          const struct = c.if_();
          c.get(P).get(TM).i32(4).shr_u().i32(15).and().i32(2).shl().add().tee(A2).i32load(8).set(TEB); // TEB reused: source pointer
          c.get(TEB);
          const nonNull = c.if_();
          // (FV the copy's address: TM keeps the spec, read again below)
          c.get(P).get(N).i32(2).shl().add().i32(8).add().tee(FV).get(TEB).get(A0).get(N).i32(2).shl().sub().i32(8).sub().memcopy();
          c.get(A2).get(FV).i32store(8);
          c.end(); void nonNull;
          c.end(); void struct;
          c.i32(DEFER_QUEUE).get(A1).get(A0).add().i32store(0);
          c.get(TM).i32(DEFER_REFS).and(); const refs = c.if_(); c.i32(DEFER_QUEUE).i32(1).i32store(4); c.end(); void refs;
          c.get(TM).i32(DEFER_TECH | DEFER_BEGIN).and();
          const fx = c.if_(); // (an effect's technique: FB = its slots)
          c.get(SP).i32load(4).i32load(12).i32(FX_SLOTS).add().set(FB);
          c.get(TM).i32(DEFER_TECH).and();
          const tq = c.if_(); c.get(FB).get(SP).i32load(8).i32load(0).i32store(0); c.end(); void tq; // (its pass count)
          c.get(TM).i32(DEFER_BEGIN).and();
          const bg = c.if_(); // (the pass count answered; the record's pointer cleared)
          c.get(SP).i32load(8).tee(FV); const out = c.if_(); c.get(FV).get(FB).i32load(0).i32store(0); c.end(); void out;
          c.get(P).i32(0).i32store(12);
          c.end(); void bg;
          c.end(); void fx;
          c.get(FE);
          const known = c.if_(); // the shadow entries hold the values set from now on (A2 = j)
          c.i32(0).set(A2);
          const wr = c.loop();
          c.get(FE).get(A2).i32(3).shl().add().tee(FV).i32(1).i32store(0);
          c.get(FV).get(VP).get(A2).i32(2).shl().add().i32load(0).i32store(4);
          c.get(A2).i32(1).add().tee(A2).get(KC).lt_u().br_if(wr);
          c.end(); void wr;
          c.end(); void known;
          c.get(TM).i32(DEFER_STATES).and();
          const states = c.if_();
          { // forget the shadow entries of the object's commit list (FB = the list, FE = the shadow block, FV = count, A2 = i)
            const done = c.block(); const stale = c.block();
            c.get(TM).i32(DEFER_END).and();
            const end = c.if_(); // (End: its Begin's restore list, taken)
            c.get(SP).i32load(4).i32load(12).i32(FX_SLOTS).add().tee(FE).i32load(4).set(FB);
            c.get(FE).i32(0).i32store(4);
            c.else_();
            c.get(SP).i32load(4).i32load(COMMIT_LIST).set(FB);
            c.end(); void end;
            c.get(FB).eqz().br_if(stale);
            c.get(FB).i32(0x7fff0000 - 4 * COMMIT_LIST_WORDS).ge_u().br_if(stale);
            c.get(FB).i32load(0).tee(FE).eqz().br_if(stale);
            c.get(FE).i32(0x7fff0000 - SHADOW_BYTES).ge_u().br_if(stale);
            c.get(FB).i32load(4).tee(FV).i32(SHADOW_ENTRIES).gt_u().br_if(stale); // (0xffffffff: any state)
            c.i32(0).set(A2);
            const lpEnd = c.block(); const lp = c.loop();
            c.get(A2).get(FV).ge_u().br_if(lpEnd);
            c.get(FB).get(A2).i32(2).shl().add().i32load(8).tee(TEB).i32(SHADOW_ENTRIES).lt_u();
            const inRange = c.if_(); c.get(FE).get(TEB).i32(3).shl().add().i32(0).i32store(16); c.end(); void inRange;
            c.get(A2).i32(1).add().set(A2); c.br(lp);
            c.end(); c.end(); void lpEnd;
            c.br(done);
            c.end(); void stale;
            c.i32(DEFER_QUEUE).i32(1).i32store(8);
            c.end(); void done;
          }
          c.end(); void states;
          // stdcall return, D3D_OK
          c.get(STATE).i32(0).i32store(ST.GPR); c.get(STATE).get(SP).i32load(0).i32store(ST.EIP);
          c.get(STATE).get(SP).i32(4).add().get(N).i32(2).shl().add().i32store(ST.GPR + 16); c.i32(1).return_();
          break;
        }
        case 17: case 18: { // a mutex (memory.js MUTEX_HANDLES, kernel32.js Mutex: P = its state: owner, count, flags)
          c.get(A0).i32(MUTEX_HANDLE_END).ge_u().get(A0).i32(3).and().or().br_if(notHandled);
          c.get(A0).i32load(MUTEX_HANDLES).tee(P).eqz().br_if(notHandled);
          if (k === 17) { // WaitForSingleObject: owned by this thread -> recursion; free, no flag -> taken; else JavaScript
            c.get(P).i32load(0).tee(TM).get(TEB).i32load(0x24).eq();
            const own = c.if_(); c.get(P).get(P).i32load(4).i32(1).add().i32store(4); c.get(STATE).i32(0); ret(2); c.end(); void own;
            c.get(TM).get(P).i32load(8).or().br_if(notHandled);
            c.get(P).get(TEB).i32load(0x24).i32store(0); c.get(P).i32(1).i32store(4);
            c.get(STATE).i32(0); ret(2);
          } else { // ReleaseMutex by its owner: one level less; the last one, without a parked waiter; else JavaScript
            c.get(P).i32load(0).get(TEB).i32load(0x24).ne().br_if(notHandled);
            c.get(P).i32load(4).i32(1).sub().tee(TM).eqz().get(P).i32load(8).i32(0).ne().and().br_if(notHandled);
            c.get(P).get(TM).i32store(4);
            c.get(TM).eqz(); const last = c.if_(); c.get(P).i32(0).i32store(0); c.end(); void last;
            c.get(STATE).i32(1); ret(1);
          }
          break;
        }
        case FID_ADDREF: case FID_RELEASE: { // IUnknown::AddRef/Release of an Orthros COM object (com.js), its count in guest memory
          // (only while no queued call may change counts: the value returned counts every reference taken so far)
          c.get(A0).i32(0x7fff0000).ge_u().br_if(notHandled);
          c.get(A0).i32load(4).i32(COM_MARKER).ne().br_if(notHandled);
          c.i32(DEFER_QUEUE).i32load(4).br_if(notHandled);
          if (k === FID_ADDREF) c.get(A0).i32load(COM_REFS).i32(1).add().set(TM);
          else { c.get(A0).i32load(COM_REFS).i32(1).sub().tee(TM).i32(1).lt_s().br_if(notHandled); } // (the last reference: JavaScript destroys)
          c.get(A0).get(TM).i32store(COM_REFS);
          c.i32(FAST_STATS).i32(FAST_STATS).i32load(4).i32(1).add().i32store(4);
          c.get(STATE).get(TM); ret(1); break;
        }
        case 19: case FID_TICKCOUNT: // timeGetTime, GetTickCount: their JavaScript handlers' value (timer-res.js) from TICK_BASE
          c.get(STATE).call(k === 19 ? mmTimeIdx : tickCountIdx).f64c(TICK_BASE).f64add().i64trunc_sat_f64_s().wrap(); ret(0); break;
        case 20: { // QueryPerformanceCounter(p): the VM clock in 100 ns units (QueryPerformanceFrequency: 10 MHz)
          c.get(A0); const nz = c.if_(); c.get(A0).call(nowIdx).f64c(10000).f64mul().f64floor().i64trunc_sat_f64_s().i64store(0, 0); c.end(); void nz;
          c.get(STATE).i32(1); ret(1); break;
        }
        case FID_PARAM_DESC: { // GetParameterDesc(this, h, desc): a description the effect's cache holds (TM = the entry)
          c.get(A0).i32(0x7fff0000).ge_u().br_if(notHandled);
          c.get(A0).i32load(4).i32(COM_MARKER).ne().br_if(notHandled); // (a live Orthros object)
          c.get(A0).i32load(12).tee(FB).eqz().br_if(notHandled);
          c.get(A1).get(FB).sub().tee(TM).i32(DEFER_HANDLE_BYTES).ge_u().get(TM).i32(3).and().or().br_if(notHandled);
          c.get(FB).i32(DEFER_HANDLE_BYTES).add().get(TM).i32(2).shr_u().i32(PARAM_DESC_SLOTS - 1).and().i32(PARAM_DESC_ENTRY).mul().add().tee(TM);
          c.i32load(0).get(A1).ne().br_if(notHandled);
          c.get(A2).eqz().get(A2).i32(0x7fff0000 - 64).ge_u().or().br_if(notHandled);
          c.get(A2).get(TM).i32(4).add().i32(PARAM_DESC_ENTRY - 4).memcopy();
          c.get(STATE).i32(0); ret(3); break;
        }
        default: // pure D3DX math (fast-d3dx.js)
          if (k >= D3DX_FAST_FIRST && k <= D3DX_FAST_LAST) emitD3dxFast(c, k, { STATE, SP, A0, A1, A2, T: [TM, N, P], F: VP + 1, notHandled, ret });
          else c.br(notHandled);
          break;
      }
    }
    c.end(); // notHandled
    c.i32(0);
    fastApiIdx = m.func([T.i32, T.i32, T.i32], [T.i32], [T.i32, T.i32, T.i32, T.i32, T.i32, T.i32, T.i32, T.i32, T.i32, T.i32, T.i32, T.i32, T.i32, T.i32, ...Array(D3DX_F64_LOCALS).fill(T.f64)], c, 'fastApi');
    m.exportFunc('fastApi', fastApiIdx);
  }

  // ---- run(eip, state / 4) -> exit code (the state block's word index: a small integer for the JS caller)
  {
    const c = new Code();
    const [EIP, STATE, STOP, E, IDX, PROBE] = [0, 1, 2, 3, 4, 5];
    c.get(STATE).i32(2).shl().set(STATE);
    // EIP from the state block (the first parameter is unused: an address from 0x40000000 up is not a small integer
    // for the JavaScript caller, and passing it allocated a number at every entry)
    c.get(STATE).i32load(ST.EIP).set(EIP);
    c.get(STATE).i32load(ST.STOP_AT).set(STOP);
    const L = c.loop();
    // stopAt
    c.get(EIP).get(STOP).eq(); const i0 = c.if_(); c.get(STATE).get(EIP).i32store(ST.EIP); c.get(STATE).i32(EXIT.HALT).i32store(ST.EXIT); c.i32(EXIT.HALT).return_(); c.end(); void i0;
    // thunk region: fast path or exit
    c.get(EIP).i32(THUNK_BASE).sub().i32(THUNK_END - THUNK_BASE).lt_u(); const i1 = c.if_();
    c.get(EIP).i32(THUNK_BASE).sub().i32(THUNK_SIZE).div_u().set(IDX);
    c.get(IDX).i32load8u(FAST_TABLE).tee(E);
    const fast = c.if_();
    c.get(E).get(STATE).get(IDX).call(fastApiIdx);
    const handled = c.if_();
    if (opts.profile) {
      c.get(E).i32(2).shl().get(E).i32(2).shl().i32load(FAST_PROF).i32(1).add().i32store(FAST_PROF);
      c.i32(0).i32load(FAST_PROF + 0x80).tee(PROBE).i32(1023).and().i32(2).shl().get(STATE).i32load(ST.EIP).i32store(FAST_PROF + 0x100);
      c.i32(0).get(PROBE).i32(1).add().i32store(FAST_PROF + 0x80);
    }
    c.get(STATE).i32load(ST.EIP).set(EIP); c.br(L); c.end(); void handled;
    c.end(); void fast;
    c.get(STATE).get(EIP).i32store(ST.EIP); c.get(STATE).i32(EXIT.THUNK).i32store(ST.EXIT);
    c.get(STATE).get(IDX).i32store(ST.EXIT_ARG); c.i32(EXIT.THUNK).return_(); c.end(); void i1;
    // budget
    c.get(STATE).i32load(ST.ICOUNT).i32(0).le_s(); const i2 = c.if_(); c.get(STATE).get(EIP).i32store(ST.EIP); c.get(STATE).i32(EXIT.TIMESLICE).i32store(ST.EXIT); c.i32(EXIT.TIMESLICE).return_(); c.end(); void i2;
    // hash lookup with linear probing (EIP 0, the key of the empty entries, always misses: see Jit.run)
    c.get(EIP).i32(0x9e3779b1 | 0).mul().i32(32 - JIT_HASH_BITS).shr_u().set(IDX);
    c.i32(0).set(PROBE);
    const found = c.block();
    const miss = c.block();
    c.get(EIP).eqz().br_if(miss);
    const probeLoop = c.loop();
    c.get(IDX).get(PROBE).add().i32((1 << JIT_HASH_BITS) - 1).and().i32(HASH_ENTRY).mul().i32(JIT_HASH_BASE).add().set(E);
    c.get(E).i32load(0).get(EIP).eq().br_if(found);
    c.get(PROBE).i32(1).add().tee(PROBE).i32(HASH_PROBES).lt_u().br_if(probeLoop);
    c.end(); // probeLoop
    c.end(); // miss
    c.get(STATE).get(EIP).i32store(ST.EIP); c.get(STATE).i32(EXIT_TRANSLATE).i32store(ST.EXIT); c.i32(EXIT_TRANSLATE).return_();
    c.end(); // found
    // call region: (block, state, registers/flags from the state block) via table[fnIdx]; ST.EIP = the
    // entry (a region specialized for another x87 mode leaves from its entry)
    c.get(STATE).get(EIP).i32store(ST.EIP);
    c.get(E).i32load(8).get(STATE);
    for (const off of REGION_ARG_OFFSETS) c.get(STATE).i32load(off);
    c.get(E).i32load(4).call_indirect(regionType, 0).tee(EIP);
    c.eqz(); const i3 = c.if_(); c.get(STATE).i32load(ST.EXIT).return_(); c.end(); void i3;
    c.br(L);
    c.end(); // loop
    c.i32(0);
    const idx = m.func([T.i32, T.i32], [T.i32], [T.i32, T.i32, T.i32, T.i32], c, 'run');
    m.exportFunc('run', idx);
  }

  // ---- chain: see chainStubCode
  {
    const idx = m.func(REGION_PARAMS, REGION_RESULTS, [T.i32, T.i32], chainStubCode(regionType, opts.countChains !== false, opts.tailCalls ?? supportsReturnCall()), 'chain');
    m.exportFunc('chain', idx);
  }
  return m.build();
}
