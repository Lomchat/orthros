// D3DX 9 math functions (d3dx9_NN.dll): matrices, vectors, planes and quaternions, as documented for the D3DX
// library. Matrices are row-major 4x4 of float32 used with row vectors (v * M). Every function writes its result
// through the output pointer and returns it (NULL when documented, e.g. a singular matrix for D3DXMatrixInverse).

/**
 * @param {Record<string, [number, Function]>} X function table being built (name -> [argc, fn])
 * @param {import('../cpu/memory.js').GuestMemory} mem
 */
export function defineD3DXMath(X, mem) {
  const f = (a, i) => mem.readF32(a + 4 * i);
  const readM = (a) => { const m = new Float64Array(16); for (let i = 0; i < 16; i++) m[i] = mem.readF32(a + 4 * i); return m; };
  const writeM = (a, m) => { for (let i = 0; i < 16; i++) mem.writeF32(a + 4 * i, m[i]); return a; };
  const readV = (a, n) => { const v = new Float64Array(n); for (let i = 0; i < n; i++) v[i] = mem.readF32(a + 4 * i); return v; };
  const writeV = (a, v) => { for (let i = 0; i < v.length; i++) mem.writeF32(a + 4 * i, v[i]); return a; };
  const mul = (a, b) => { const r = new Float64Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { let s = 0; for (let k = 0; k < 4; k++) s += a[i * 4 + k] * b[k * 4 + j]; r[i * 4 + j] = s; } return r; };
  const ident = () => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
  const transform4 = (v, m) => { const r = new Float64Array(4); for (let j = 0; j < 4; j++) r[j] = v[0] * m[j] + v[1] * m[4 + j] + v[2] * m[8 + j] + v[3] * m[12 + j]; return r; };
  const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return l ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 0]; };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  /** inverse and determinant of a general 4x4 (cofactors), null when singular */
  const inverse = (m) => {
    const inv = new Float64Array(16);
    inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
    inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
    inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
    inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
    inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
    inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
    inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
    inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
    inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
    inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
    inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
    inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
    inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
    inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
    inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
    inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
    const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
    if (det === 0 || !Number.isFinite(det)) return [null, det];
    for (let i = 0; i < 16; i++) inv[i] /= det;
    return [inv, det];
  };
  const rotAxis = (axis, a) => {
    const [x, y, z] = norm3(axis), c = Math.cos(a), s = Math.sin(a), t = 1 - c, m = ident();
    m[0] = t * x * x + c; m[1] = t * x * y + s * z; m[2] = t * x * z - s * y;
    m[4] = t * x * y - s * z; m[5] = t * y * y + c; m[6] = t * y * z + s * x;
    m[8] = t * x * z + s * y; m[9] = t * y * z - s * x; m[10] = t * z * z + c;
    return m;
  };
  const quatToMatrix = (q) => {
    const [x, y, z, w] = q, m = ident();
    m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + z * w); m[2] = 2 * (x * z - y * w);
    m[4] = 2 * (x * y - z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + x * w);
    m[8] = 2 * (x * z + y * w); m[9] = 2 * (y * z - x * w); m[10] = 1 - 2 * (x * x + y * y);
    return m;
  };
  const yawPitchRoll = (yaw, pitch, roll) => mul(mul(rotAxis([0, 0, 1], roll), rotAxis([1, 0, 0], pitch)), rotAxis([0, 1, 0], yaw));
  const slerp = (a, b, t) => {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], sign = 1;
    if (d < 0) { d = -d; sign = -1; }
    let s0 = 1 - t, s1 = t;
    if (1 - d > 1e-6) { const th = Math.acos(d), st = Math.sin(th); s0 = Math.sin((1 - t) * th) / st; s1 = Math.sin(t * th) / st; }
    s1 *= sign;
    return [s0 * a[0] + s1 * b[0], s0 * a[1] + s1 * b[1], s0 * a[2] + s1 * b[2], s0 * a[3] + s1 * b[3]];
  };
  const lookAt = (eye, at, up, rh) => {
    const zaxis = norm3(rh ? [eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]] : [at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]]);
    const xaxis = norm3(cross(up, zaxis)), yaxis = cross(zaxis, xaxis), m = ident();
    m[0] = xaxis[0]; m[1] = yaxis[0]; m[2] = zaxis[0];
    m[4] = xaxis[1]; m[5] = yaxis[1]; m[6] = zaxis[1];
    m[8] = xaxis[2]; m[9] = yaxis[2]; m[10] = zaxis[2];
    m[12] = -dot3(xaxis, eye); m[13] = -dot3(yaxis, eye); m[14] = -dot3(zaxis, eye);
    return m;
  };

  X.D3DXMatrixMultiply = [3, (c) => writeM(c.arg(0), mul(readM(c.arg(1)), readM(c.arg(2))))];
  X.D3DXMatrixMultiplyTranspose = [3, (c) => { const r = mul(readM(c.arg(1)), readM(c.arg(2))), t = new Float64Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) t[i * 4 + j] = r[j * 4 + i]; return writeM(c.arg(0), t); }];
  X.D3DXMatrixInverse = [3, (c) => { const [inv, det] = inverse(readM(c.arg(2))); if (c.arg(1)) mem.writeF32(c.arg(1), det); if (!inv) return 0; return writeM(c.arg(0), inv); }];
  X.D3DXMatrixDeterminant = [1, (c) => { c.retDouble(inverse(readM(c.arg(0)))[1]); }];
  X.D3DXMatrixTranspose = [2, (c) => { const m = readM(c.arg(1)), t = new Float64Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) t[i * 4 + j] = m[j * 4 + i]; return writeM(c.arg(0), t); }];
  X.D3DXMatrixRotationX = [2, (c) => writeM(c.arg(0), rotAxis([1, 0, 0], c.argF32(1)))];
  X.D3DXMatrixRotationY = [2, (c) => writeM(c.arg(0), rotAxis([0, 1, 0], c.argF32(1)))];
  X.D3DXMatrixRotationZ = [2, (c) => writeM(c.arg(0), rotAxis([0, 0, 1], c.argF32(1)))];
  X.D3DXMatrixRotationAxis = [3, (c) => writeM(c.arg(0), rotAxis(readV(c.arg(1), 3), c.argF32(2)))];
  X.D3DXMatrixRotationQuaternion = [2, (c) => writeM(c.arg(0), quatToMatrix(readV(c.arg(1), 4)))];
  X.D3DXMatrixRotationYawPitchRoll = [4, (c) => writeM(c.arg(0), yawPitchRoll(c.argF32(1), c.argF32(2), c.argF32(3)))];
  X.D3DXMatrixScaling = [4, (c) => { const m = ident(); m[0] = c.argF32(1); m[5] = c.argF32(2); m[10] = c.argF32(3); return writeM(c.arg(0), m); }];
  X.D3DXMatrixTranslation = [4, (c) => { const m = ident(); m[12] = c.argF32(1); m[13] = c.argF32(2); m[14] = c.argF32(3); return writeM(c.arg(0), m); }];
  X.D3DXMatrixLookAtLH = [4, (c) => writeM(c.arg(0), lookAt(readV(c.arg(1), 3), readV(c.arg(2), 3), readV(c.arg(3), 3), false))];
  X.D3DXMatrixLookAtRH = [4, (c) => writeM(c.arg(0), lookAt(readV(c.arg(1), 3), readV(c.arg(2), 3), readV(c.arg(3), 3), true))];
  const persp = (c, rh) => { const fov = c.argF32(1), aspect = c.argF32(2), zn = c.argF32(3), zf = c.argF32(4), ys = 1 / Math.tan(fov / 2), m = new Float64Array(16); m[0] = ys / aspect; m[5] = ys; m[10] = (rh ? -1 : 1) * zf / (zf - zn); m[11] = rh ? -1 : 1; m[14] = -zn * zf / (zf - zn); return writeM(c.arg(0), m); };
  X.D3DXMatrixPerspectiveFovLH = [5, (c) => persp(c, false)];
  X.D3DXMatrixPerspectiveFovRH = [5, (c) => persp(c, true)];
  X.D3DXMatrixPerspectiveLH = [5, (c) => { const w = c.argF32(1), h = c.argF32(2), zn = c.argF32(3), zf = c.argF32(4), m = new Float64Array(16); m[0] = 2 * zn / w; m[5] = 2 * zn / h; m[10] = zf / (zf - zn); m[11] = 1; m[14] = zn * zf / (zn - zf); return writeM(c.arg(0), m); }];
  const ortho = (c, l, r, b, t, zn, zf, rh) => { const m = ident(); m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = (rh ? -1 : 1) / (zf - zn); m[12] = (l + r) / (l - r); m[13] = (t + b) / (b - t); m[14] = zn / (zn - zf); return writeM(c.arg(0), m); };
  X.D3DXMatrixOrthoLH = [5, (c) => { const w = c.argF32(1), h = c.argF32(2); return ortho(c, -w / 2, w / 2, -h / 2, h / 2, c.argF32(3), c.argF32(4), false); }];
  X.D3DXMatrixOrthoRH = [5, (c) => { const w = c.argF32(1), h = c.argF32(2); return ortho(c, -w / 2, w / 2, -h / 2, h / 2, c.argF32(3), c.argF32(4), true); }];
  X.D3DXMatrixOrthoOffCenterLH = [7, (c) => ortho(c, c.argF32(1), c.argF32(2), c.argF32(3), c.argF32(4), c.argF32(5), c.argF32(6), false)];
  X.D3DXMatrixOrthoOffCenterRH = [7, (c) => ortho(c, c.argF32(1), c.argF32(2), c.argF32(3), c.argF32(4), c.argF32(5), c.argF32(6), true)];
  X.D3DXMatrixReflect = [2, (c) => { const p = readV(c.arg(1), 4), l = Math.hypot(p[0], p[1], p[2]) || 1, [a, b, cc, d] = [p[0] / l, p[1] / l, p[2] / l, p[3] / l], m = ident(); m[0] = 1 - 2 * a * a; m[1] = -2 * b * a; m[2] = -2 * cc * a; m[4] = -2 * a * b; m[5] = 1 - 2 * b * b; m[6] = -2 * cc * b; m[8] = -2 * a * cc; m[9] = -2 * b * cc; m[10] = 1 - 2 * cc * cc; m[12] = -2 * a * d; m[13] = -2 * b * d; m[14] = -2 * cc * d; return writeM(c.arg(0), m); }];
  X.D3DXMatrixShadow = [3, (c) => { const L = readV(c.arg(1), 4), p = readV(c.arg(2), 4), l = Math.hypot(p[0], p[1], p[2]) || 1, P = [p[0] / l, p[1] / l, p[2] / l, p[3] / l], d = P[0] * L[0] + P[1] * L[1] + P[2] * L[2] + P[3] * L[3], m = new Float64Array(16); for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) m[i * 4 + j] = (i === j ? d : 0) - L[j] * P[i]; return writeM(c.arg(0), m); }];
  X.D3DXMatrixAffineTransformation = [5, (c) => {
    const s = c.argF32(1), rc = c.arg(2) ? readV(c.arg(2), 3) : [0, 0, 0], q = c.arg(3) ? readV(c.arg(3), 4) : [0, 0, 0, 1], t = c.arg(4) ? readV(c.arg(4), 3) : [0, 0, 0];
    const S = ident(); S[0] = S[5] = S[10] = s;
    const toC = ident(); toC[12] = -rc[0]; toC[13] = -rc[1]; toC[14] = -rc[2];
    const back = ident(); back[12] = rc[0] + t[0]; back[13] = rc[1] + t[1]; back[14] = rc[2] + t[2];
    return writeM(c.arg(0), mul(mul(mul(S, toC), quatToMatrix(q)), back));
  }];
  X.D3DXMatrixDecompose = [4, (c) => {
    const m = readM(c.arg(3)), sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
    if (c.arg(0)) writeV(c.arg(0), [sx, sy, sz]);
    if (c.arg(2)) writeV(c.arg(2), [m[12], m[13], m[14]]);
    if (!sx || !sy || !sz) return 0x8876086c;
    const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
    const tr = r[0] + r[4] + r[8]; let q;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(r[5] - r[7]) / s, (r[6] - r[2]) / s, (r[1] - r[3]) / s, s / 4]; }
    else if (r[0] > r[4] && r[0] > r[8]) { const s = Math.sqrt(1 + r[0] - r[4] - r[8]) * 2; q = [s / 4, (r[1] + r[3]) / s, (r[6] + r[2]) / s, (r[5] - r[7]) / s]; }
    else if (r[4] > r[8]) { const s = Math.sqrt(1 + r[4] - r[0] - r[8]) * 2; q = [(r[1] + r[3]) / s, s / 4, (r[5] + r[7]) / s, (r[6] - r[2]) / s]; }
    else { const s = Math.sqrt(1 + r[8] - r[0] - r[4]) * 2; q = [(r[6] + r[2]) / s, (r[5] + r[7]) / s, s / 4, (r[1] - r[3]) / s]; }
    if (c.arg(1)) writeV(c.arg(1), q);
    return 0;
  }];
  // vectors
  X.D3DXVec3Transform = [3, (c) => { const v = readV(c.arg(1), 3); return writeV(c.arg(0), transform4([v[0], v[1], v[2], 1], readM(c.arg(2)))); }];
  X.D3DXVec3TransformCoord = [3, (c) => { const v = readV(c.arg(1), 3), r = transform4([v[0], v[1], v[2], 1], readM(c.arg(2))); const w = r[3] || 1; return writeV(c.arg(0), [r[0] / w, r[1] / w, r[2] / w]); }];
  X.D3DXVec3TransformNormal = [3, (c) => { const v = readV(c.arg(1), 3), r = transform4([v[0], v[1], v[2], 0], readM(c.arg(2))); return writeV(c.arg(0), [r[0], r[1], r[2]]); }];
  const arrayOp = (c, inN, w, outN, div) => { const out = c.arg(0), os = c.arg(1), v = c.arg(2), vs = c.arg(3), m = readM(c.arg(4)), n = c.arg(5); for (let i = 0; i < n; i++) { const a = readV(v + i * vs, inN); const r = transform4([a[0], a[1], a[2] ?? 0, inN === 4 ? a[3] : w], m); const d = div ? (r[3] || 1) : 1; writeV(out + i * os, outN === 4 ? r : [r[0] / d, r[1] / d, r[2] / d]); } return out; };
  X.D3DXVec3TransformArray = [6, (c) => arrayOp(c, 3, 1, 4, false)];
  X.D3DXVec3TransformCoordArray = [6, (c) => arrayOp(c, 3, 1, 3, true)];
  X.D3DXVec3TransformNormalArray = [6, (c) => arrayOp(c, 3, 0, 3, false)];
  X.D3DXVec4TransformArray = [6, (c) => arrayOp(c, 4, 0, 4, false)];
  X.D3DXVec4Transform = [3, (c) => writeV(c.arg(0), transform4(readV(c.arg(1), 4), readM(c.arg(2))))];
  X.D3DXVec2Transform = [3, (c) => { const v = readV(c.arg(1), 2); return writeV(c.arg(0), transform4([v[0], v[1], 0, 1], readM(c.arg(2)))); }];
  X.D3DXVec2TransformCoord = [3, (c) => { const v = readV(c.arg(1), 2), r = transform4([v[0], v[1], 0, 1], readM(c.arg(2))), w = r[3] || 1; return writeV(c.arg(0), [r[0] / w, r[1] / w]); }];
  X.D3DXVec3Normalize = [2, (c) => writeV(c.arg(0), norm3(readV(c.arg(1), 3)))];
  X.D3DXVec2Normalize = [2, (c) => { const v = readV(c.arg(1), 2), l = Math.hypot(v[0], v[1]); return writeV(c.arg(0), l ? [v[0] / l, v[1] / l] : [0, 0]); }];
  X.D3DXVec4Normalize = [2, (c) => { const v = readV(c.arg(1), 4), l = Math.hypot(v[0], v[1], v[2], v[3]); return writeV(c.arg(0), l ? [...v].map((x) => x / l) : [0, 0, 0, 0]); }];
  X.D3DXVec3Cross = [3, (c) => writeV(c.arg(0), cross(readV(c.arg(1), 3), readV(c.arg(2), 3)))];
  const catmull = (c, n) => { const s = c.argF32(5), [p0, p1, p2, p3] = [1, 2, 3, 4].map((i) => readV(c.arg(i), n)), r = []; for (let i = 0; i < n; i++) r.push(0.5 * (2 * p1[i] + (p2[i] - p0[i]) * s + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * s * s + (3 * p1[i] - p0[i] - 3 * p2[i] + p3[i]) * s * s * s)); return writeV(c.arg(0), r); };
  X.D3DXVec3CatmullRom = [6, (c) => catmull(c, 3)];
  X.D3DXVec2CatmullRom = [6, (c) => catmull(c, 2)];
  X.D3DXVec4CatmullRom = [6, (c) => catmull(c, 4)];
  const hermite = (c, n) => { const s = c.argF32(5), [p1, t1, p2, t2] = [1, 2, 3, 4].map((i) => readV(c.arg(i), n)), s2 = s * s, s3 = s2 * s, h1 = 2 * s3 - 3 * s2 + 1, h2 = s3 - 2 * s2 + s, h3 = -2 * s3 + 3 * s2, h4 = s3 - s2, r = []; for (let i = 0; i < n; i++) r.push(h1 * p1[i] + h2 * t1[i] + h3 * p2[i] + h4 * t2[i]); return writeV(c.arg(0), r); };
  X.D3DXVec3Hermite = [6, (c) => hermite(c, 3)];
  X.D3DXVec2Hermite = [6, (c) => hermite(c, 2)];
  X.D3DXVec3Project = [6, (c) => { const v = readV(c.arg(1), 3), vp = c.arg(2);
    const world = c.arg(5) ? readM(c.arg(5)) : ident(), view = c.arg(4) ? readM(c.arg(4)) : ident(), proj = c.arg(3) ? readM(c.arg(3)) : ident();
    const r = transform4([v[0], v[1], v[2], 1], mul(mul(world, view), proj)), w = r[3] || 1;
    const x = vp ? mem.read32(vp) : 0, y = vp ? mem.read32(vp + 4) : 0, W = vp ? mem.read32(vp + 8) : 1, H = vp ? mem.read32(vp + 12) : 1, zn = vp ? f(vp, 4) : 0, zf = vp ? f(vp, 5) : 1;
    return writeV(c.arg(0), [x + (1 + r[0] / w) * W / 2, y + (1 - r[1] / w) * H / 2, zn + (r[2] / w) * (zf - zn)]); }];
  X.D3DXVec3Unproject = [6, (c) => { const v = readV(c.arg(1), 3), vp = c.arg(2);
    const world = c.arg(5) ? readM(c.arg(5)) : ident(), view = c.arg(4) ? readM(c.arg(4)) : ident(), proj = c.arg(3) ? readM(c.arg(3)) : ident();
    const [inv] = inverse(mul(mul(world, view), proj)); if (!inv) return 0;
    const x = vp ? mem.read32(vp) : 0, y = vp ? mem.read32(vp + 4) : 0, W = vp ? mem.read32(vp + 8) : 1, H = vp ? mem.read32(vp + 12) : 1, zn = vp ? f(vp, 4) : 0, zf = vp ? f(vp, 5) : 1;
    const r = transform4([2 * (v[0] - x) / W - 1, 1 - 2 * (v[1] - y) / H, (v[2] - zn) / (zf - zn), 1], inv), w = r[3] || 1;
    return writeV(c.arg(0), [r[0] / w, r[1] / w, r[2] / w]); }];
  // planes
  X.D3DXPlaneFromPointNormal = [3, (c) => { const p = readV(c.arg(1), 3), n = readV(c.arg(2), 3); return writeV(c.arg(0), [n[0], n[1], n[2], -dot3(p, n)]); }];
  X.D3DXPlaneFromPoints = [4, (c) => { const a = readV(c.arg(1), 3), b = readV(c.arg(2), 3), d = readV(c.arg(3), 3); const n = norm3(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [d[0] - a[0], d[1] - a[1], d[2] - a[2]])); return writeV(c.arg(0), [n[0], n[1], n[2], -dot3(a, n)]); }];
  X.D3DXPlaneNormalize = [2, (c) => { const p = readV(c.arg(1), 4), l = Math.hypot(p[0], p[1], p[2]); return writeV(c.arg(0), l ? [p[0] / l, p[1] / l, p[2] / l, p[3] / l] : [0, 0, 0, 0]); }];
  X.D3DXPlaneTransform = [3, (c) => writeV(c.arg(0), transform4(readV(c.arg(1), 4), readM(c.arg(2))))];
  X.D3DXPlaneIntersectLine = [4, (c) => { const p = readV(c.arg(1), 4), a = readV(c.arg(2), 3), b = readV(c.arg(3), 3), d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], den = p[0] * d[0] + p[1] * d[1] + p[2] * d[2]; if (!den) return 0; const t = -(p[0] * a[0] + p[1] * a[1] + p[2] * a[2] + p[3]) / den; return writeV(c.arg(0), [a[0] + t * d[0], a[1] + t * d[1], a[2] + t * d[2]]); }];
  // quaternions
  X.D3DXQuaternionSlerp = [4, (c) => writeV(c.arg(0), slerp(readV(c.arg(1), 4), readV(c.arg(2), 4), c.argF32(3)))];
  X.D3DXQuaternionNormalize = [2, (c) => { const q = readV(c.arg(1), 4), l = Math.hypot(q[0], q[1], q[2], q[3]); return writeV(c.arg(0), l ? [...q].map((x) => x / l) : [0, 0, 0, 0]); }];
  X.D3DXQuaternionMultiply = [3, (c) => { const a = readV(c.arg(1), 4), b = readV(c.arg(2), 4); // D3DX order: result = a then b (b * a in Hamilton terms)
    return writeV(c.arg(0), [b[3] * a[0] + b[0] * a[3] + b[1] * a[2] - b[2] * a[1], b[3] * a[1] - b[0] * a[2] + b[1] * a[3] + b[2] * a[0], b[3] * a[2] + b[0] * a[1] - b[1] * a[0] + b[2] * a[3], b[3] * a[3] - b[0] * a[0] - b[1] * a[1] - b[2] * a[2]]); }];
  X.D3DXQuaternionRotationAxis = [3, (c) => { const [x, y, z] = norm3(readV(c.arg(1), 3)), h = c.argF32(2) / 2, s = Math.sin(h); return writeV(c.arg(0), [x * s, y * s, z * s, Math.cos(h)]); }];
  X.D3DXQuaternionRotationYawPitchRoll = [4, (c) => { const y = c.argF32(1) / 2, p = c.argF32(2) / 2, r = c.argF32(3) / 2, [sy, cy, sp, cp, sr, cr] = [Math.sin(y), Math.cos(y), Math.sin(p), Math.cos(p), Math.sin(r), Math.cos(r)];
    return writeV(c.arg(0), [cy * sp * cr + sy * cp * sr, sy * cp * cr - cy * sp * sr, cy * cp * sr - sy * sp * cr, cy * cp * cr + sy * sp * sr]); }];
  X.D3DXQuaternionRotationMatrix = [2, (c) => { const m = readM(c.arg(1)), tr = m[0] + m[5] + m[10]; let q;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m[6] - m[9]) / s, (m[8] - m[2]) / s, (m[1] - m[4]) / s, s / 4]; }
    else if (m[0] > m[5] && m[0] > m[10]) { const s = Math.sqrt(1 + m[0] - m[5] - m[10]) * 2; q = [s / 4, (m[1] + m[4]) / s, (m[8] + m[2]) / s, (m[6] - m[9]) / s]; }
    else if (m[5] > m[10]) { const s = Math.sqrt(1 + m[5] - m[0] - m[10]) * 2; q = [(m[1] + m[4]) / s, s / 4, (m[6] + m[9]) / s, (m[8] - m[2]) / s]; }
    else { const s = Math.sqrt(1 + m[10] - m[0] - m[5]) * 2; q = [(m[8] + m[2]) / s, (m[6] + m[9]) / s, s / 4, (m[1] - m[4]) / s]; }
    return writeV(c.arg(0), q); }];
  X.D3DXQuaternionInverse = [2, (c) => { const q = readV(c.arg(1), 4), n = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]; return writeV(c.arg(0), n ? [-q[0] / n, -q[1] / n, -q[2] / n, q[3] / n] : [0, 0, 0, 0]); }];
  X.D3DXQuaternionToAxisAngle = [3, (c) => { const q = readV(c.arg(0), 4); if (c.arg(1)) writeV(c.arg(1), [q[0], q[1], q[2]]); if (c.arg(2)) mem.writeF32(c.arg(2), 2 * Math.acos(Math.max(-1, Math.min(1, q[3])))); }];
  // colors
  X.D3DXColorAdjustSaturation = [3, (c) => { const v = readV(c.arg(1), 4), s = c.argF32(2), g = v[0] * 0.2125 + v[1] * 0.7154 + v[2] * 0.0721; return writeV(c.arg(0), [g + s * (v[0] - g), g + s * (v[1] - g), g + s * (v[2] - g), v[3]]); }];
  X.D3DXColorAdjustContrast = [3, (c) => { const v = readV(c.arg(1), 4), s = c.argF32(2); return writeV(c.arg(0), [0.5 + s * (v[0] - 0.5), 0.5 + s * (v[1] - 0.5), 0.5 + s * (v[2] - 0.5), v[3]]); }];
  // float16 conversions
  X.D3DXFloat32To16Array = [3, (c) => { const out = c.arg(0), src = c.arg(1), n = c.arg(2); for (let i = 0; i < n; i++) mem.write16(out + 2 * i, toHalf(mem.readF32(src + 4 * i))); return out; }];
  X.D3DXFloat16To32Array = [3, (c) => { const out = c.arg(0), src = c.arg(1), n = c.arg(2); for (let i = 0; i < n; i++) mem.writeF32(out + 4 * i, fromHalf(mem.read16(src + 2 * i))); return out; }];
}

const hf = new Float32Array(1), hu = new Uint32Array(hf.buffer);
/** float32 -> IEEE half bits (round to nearest even) */
export function toHalf(v) {
  hf[0] = v; const x = hu[0], sign = (x >>> 16) & 0x8000, e = (x >>> 23) & 0xff, m = x & 0x7fffff;
  if (e === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
  const E = e - 127 + 15;
  if (E >= 31) return sign | 0x7c00;
  if (E <= 0) { if (E < -10) return sign; const mm = (m | 0x800000) >> (1 - E); return sign | ((mm + 0xfff + ((mm >> 13) & 1)) >> 13); }
  let r = sign | (E << 10) | (m >> 13); const rem = m & 0x1fff; if (rem > 0x1000 || (rem === 0x1000 && (r & 1))) r++; return r;
}
/** IEEE half bits -> number */
export function fromHalf(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}
