// WASM fast paths of pure D3DX math functions (runtime.js fastApi): the JavaScript handlers' results bit for bit
// (src/win32/d3dx9-math.js) — the same f64 operations in the same order on the f32 inputs, rounded to f32 once at the
// store — without leaving the translated code. A pointer the WASM memory cannot address goes to JavaScript (its
// handler raises as before). Unit test: tests/jit-fast-d3dx.test.js compares both on random and special inputs.

/** fast API ids (runtime.js fastApi) by D3DX export name, for every d3dx9_NN.dll */
export const D3DX_FAST = Object.freeze({ D3DXMatrixInverse: 23, D3DXVec2CatmullRom: 24, D3DXVec3CatmullRom: 25, D3DXVec4CatmullRom: 26 });
export const D3DX_FAST_FIRST = 23, D3DX_FAST_LAST = 26;
/** f64 locals the emitters use */
export const D3DX_F64_LOCALS = 40;

/** The fast API id of thunk `key` ('d3dx9_27.dll!D3DXMatrixInverse'), or undefined. */
export function d3dxFastId(key) {
  if (!key.startsWith('d3dx9_')) return undefined;
  const name = key.slice(key.indexOf('!') + 1);
  return Object.hasOwn(D3DX_FAST, name) ? D3DX_FAST[name] : undefined;
}

// The cofactors of d3dx9-math.js inverse(), as written there (inv[0..15]): each a signed sum of triple products,
// evaluated left to right (a leading '-' negates the first factor).
const COFACTORS = [
  'm[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10]',
  '-m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10]',
  'm[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6]',
  '-m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6]',
  '-m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10]',
  'm[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10]',
  '-m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6]',
  'm[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6]',
  'm[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9]',
  '-m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9]',
  'm[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5]',
  '-m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5]',
  '-m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9]',
  'm[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9]',
  '-m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5]',
  'm[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5]',
];
/** [negate first factor, [[op ('+'|'-'|''), i, j, k]...]] */
function parseCofactor(s) {
  const terms = [];
  const re = /(^-|[+-]|^)\s*m\[(\d+)\] \* m\[(\d+)\] \* m\[(\d+)\]/g;
  let m, at = 0;
  while ((m = re.exec(s))) { terms.push([m[1], +m[2], +m[3], +m[4]]); at = re.lastIndex; }
  if (at !== s.length || terms.length !== 6) throw new Error(`fast-d3dx: cofactor not parsed: ${s}`);
  return terms;
}
const PARSED = COFACTORS.map(parseCofactor);
export const COFACTORS_FOR_TEST = COFACTORS;

/**
 * Emit fast API `fid` into the fastApi function body.
 * @param {import('./wasm.js').Code} c
 * @param {number} fid
 * @param {{ STATE: number, SP: number, A0: number, A1: number, A2: number, T: number[], F: number, notHandled: number, ret: (argc: number) => void }} L
 *   locals (T: four spare i32 locals, F: the first of D3DX_F64_LOCALS f64 locals), the not-handled label, the stdcall return
 */
export function emitD3dxFast(c, fid, L) {
  const { STATE, SP, A0, A1, A2, T, F, notHandled, ret } = L;
  const LIM = 0x7fff0000;
  const guard = (local, bytes) => { c.get(local).i32(LIM - bytes).ge_u().br_if(notHandled); };
  if (fid === D3DX_FAST.D3DXMatrixInverse) { // (out, pDeterminant, m)
    const M = F, INV = F + 16, DET = F + 32;
    guard(A0, 64); guard(A2, 64);
    c.get(A1); const hasDet = c.if_(); guard(A1, 4); c.end(); void hasDet;
    for (let i = 0; i < 16; i++) c.get(A2).f32load(4 * i).f64promote().set(M + i);
    PARSED.forEach((terms, k) => {
      terms.forEach(([op, i, j, l], n) => {
        c.get(M + i); if (op === '-' && n === 0) c.f64neg();
        c.get(M + j).f64mul().get(M + l).f64mul();
        if (n > 0) { if (op === '+') c.f64add(); else c.f64sub(); }
      });
      c.set(INV + k);
    });
    c.get(M + 0).get(INV + 0).f64mul().get(M + 1).get(INV + 4).f64mul().f64add().get(M + 2).get(INV + 8).f64mul().f64add().get(M + 3).get(INV + 12).f64mul().f64add().set(DET);
    c.get(A1); const wr = c.if_(); c.get(A1).get(DET).f32demote().f32store(0); c.end(); void wr;
    // singular (or not finite): NULL, the output untouched
    c.get(DET).f64c(0).f64eq().get(DET).f64abs().f64c(Infinity).f64lt().eqz().or();
    const bad = c.if_(); c.get(STATE).i32(0); ret(3); c.end(); void bad;
    for (let i = 0; i < 16; i++) c.get(A0).get(INV + i).get(DET).f64div().f32demote().f32store(4 * i);
    c.get(STATE).get(A0); ret(3);
    return;
  }
  // D3DXVec{2,3,4}CatmullRom(out, v0, v1, v2, v3, s)
  const n = fid - D3DX_FAST.D3DXVec2CatmullRom + 2;
  const [P1, P2, P3] = T; // v1..v3 (v0 is A1, out A0)
  c.get(SP).i32load(12).set(P1); c.get(SP).i32load(16).set(P2); c.get(SP).i32load(20).set(P3);
  for (const p of [A0, A1, P1, P2, P3]) guard(p, 4 * n);
  const S = F, p0 = F + 1, p1 = F + 2, p2 = F + 3, p3 = F + 4, R = F + 5;
  c.get(SP).f32load(24).f64promote().set(S);
  for (let i = 0; i < n; i++) {
    c.get(A1).f32load(4 * i).f64promote().set(p0); c.get(P1).f32load(4 * i).f64promote().set(p1);
    c.get(P2).f32load(4 * i).f64promote().set(p2); c.get(P3).f32load(4 * i).f64promote().set(p3);
    // 0.5 * (2 * p1 + (p2 - p0) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s + (3 * p1 - p0 - 3 * p2 + p3) * s * s * s)
    c.f64c(0.5);
    c.f64c(2).get(p1).f64mul();
    c.get(p2).get(p0).f64sub().get(S).f64mul().f64add();
    c.f64c(2).get(p0).f64mul().f64c(5).get(p1).f64mul().f64sub().f64c(4).get(p2).f64mul().f64add().get(p3).f64sub().get(S).f64mul().get(S).f64mul().f64add();
    c.f64c(3).get(p1).f64mul().get(p0).f64sub().f64c(3).get(p2).f64mul().f64sub().get(p3).f64add().get(S).f64mul().get(S).f64mul().get(S).f64mul().f64add();
    c.f64mul().set(R + i);
  }
  for (let i = 0; i < n; i++) c.get(A0).get(R + i).f32demote().f32store(4 * i); // (after every read: the output may be an input)
  c.get(STATE).get(A0); ret(6);
}
