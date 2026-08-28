/**
 * D3DX math helpers (matrices, vectors, planes).
 */

import { Mem } from '../../core/memory/mem-accessor';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';

export function u32AsFloat(value: number): number {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, value >>> 0, true);
    return view.getFloat32(0, true);
}

function readMatrix(addr: number): Float32Array | null {
    if (!addr) return null;
    const out = new Float32Array(16);
    for (let i = 0; i < 16; i++) {
        const v = Mem.readFloat32(addr + i * 4);
        if (v === null) return null;
        out[i] = v;
    }
    return out;
}

function writeMatrix(addr: number, m: Float32Array): boolean {
    if (!addr) return false;
    for (let i = 0; i < 16; i++) {
        if (!Mem.writeFloat32(addr + i * 4, m[i])) return false;
    }
    return true;
}

function readVec3(addr: number): [number, number, number] | null {
    if (!addr) return null;
    const x = Mem.readFloat32(addr);
    const y = Mem.readFloat32(addr + 4);
    const z = Mem.readFloat32(addr + 8);
    if (x === null || y === null || z === null) return null;
    return [x, y, z];
}

function writeVec3(addr: number, x: number, y: number, z: number): boolean {
    if (!addr) return false;
    return Mem.writeFloat32(addr, x)
        && Mem.writeFloat32(addr + 4, y)
        && Mem.writeFloat32(addr + 8, z);
}

function readVec4(addr: number): [number, number, number, number] | null {
    if (!addr) return null;
    const x = Mem.readFloat32(addr);
    const y = Mem.readFloat32(addr + 4);
    const z = Mem.readFloat32(addr + 8);
    const w = Mem.readFloat32(addr + 12);
    if (x === null || y === null || z === null || w === null) return null;
    return [x, y, z, w];
}

function writeVec4(addr: number, x: number, y: number, z: number, w: number): boolean {
    if (!addr) return false;
    return Mem.writeFloat32(addr, x)
        && Mem.writeFloat32(addr + 4, y)
        && Mem.writeFloat32(addr + 8, z)
        && Mem.writeFloat32(addr + 12, w);
}

export function multiplyMatrices(a: Float32Array, b: Float32Array): Float32Array {
    const out = new Float32Array(16);
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                sum += a[row * 4 + k] * b[k * 4 + col];
            }
            out[row * 4 + col] = sum;
        }
    }
    return out;
}

/** General 4x4 inverse with partial pivoting. D3DX matrices use the same row-major layout. */
export function invertMatrix4(matrix: Float32Array): { inverse: Float32Array; determinant: number } | null {
    const rows: number[][] = [];
    for (let row = 0; row < 4; row++) {
        rows[row] = [];
        for (let col = 0; col < 4; col++) rows[row][col] = matrix[row * 4 + col];
        for (let col = 0; col < 4; col++) rows[row][4 + col] = row === col ? 1 : 0;
    }

    let determinant = 1;
    let sign = 1;
    for (let col = 0; col < 4; col++) {
        let pivotRow = col;
        let pivotAbs = Math.abs(rows[col][col]);
        for (let row = col + 1; row < 4; row++) {
            const candidate = Math.abs(rows[row][col]);
            if (candidate > pivotAbs) {
                pivotAbs = candidate;
                pivotRow = row;
            }
        }
        if (pivotAbs === 0 || !Number.isFinite(pivotAbs)) return null;
        if (pivotRow !== col) {
            [rows[col], rows[pivotRow]] = [rows[pivotRow], rows[col]];
            sign = -sign;
        }

        const pivot = rows[col][col];
        determinant *= pivot;
        for (let i = 0; i < 8; i++) rows[col][i] /= pivot;
        for (let row = 0; row < 4; row++) {
            if (row === col) continue;
            const factor = rows[row][col];
            if (factor === 0) continue;
            for (let i = 0; i < 8; i++) rows[row][i] -= factor * rows[col][i];
        }
    }

    const inverse = new Float32Array(16);
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) inverse[row * 4 + col] = rows[row][4 + col];
    }
    return { inverse, determinant: determinant * sign };
}

function transformVec4(v: readonly number[], m: Float32Array): [number, number, number, number] {
    return [
        v[0] * m[0] + v[1] * m[4] + v[2] * m[8] + v[3] * m[12],
        v[0] * m[1] + v[1] * m[5] + v[2] * m[9] + v[3] * m[13],
        v[0] * m[2] + v[1] * m[6] + v[2] * m[10] + v[3] * m[14],
        v[0] * m[3] + v[1] * m[7] + v[2] * m[11] + v[3] * m[15],
    ];
}

export function createMathExports(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['D3DXMatrixIdentity'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const m = new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ]);
        return writeMatrix(pOut, m) ? pOut : 0;
    };

    exports['D3DXMatrixMultiply'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const m1 = readMatrix(args[1] >>> 0);
        const m2 = readMatrix(args[2] >>> 0);
        if (!m1 || !m2) return 0;
        return writeMatrix(pOut, multiplyMatrices(m1, m2)) ? pOut : 0;
    };

    exports['D3DXMatrixTranslation'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const x = u32AsFloat(args[1]);
        const y = u32AsFloat(args[2]);
        const z = u32AsFloat(args[3]);
        const m = new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            x, y, z, 1,
        ]);
        return writeMatrix(pOut, m) ? pOut : 0;
    };

    exports['D3DXMatrixScaling'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const x = u32AsFloat(args[1]);
        const y = u32AsFloat(args[2]);
        const z = u32AsFloat(args[3]);
        const m = new Float32Array([
            x, 0, 0, 0,
            0, y, 0, 0,
            0, 0, z, 0,
            0, 0, 0, 1,
        ]);
        return writeMatrix(pOut, m) ? pOut : 0;
    };

    exports['D3DXMatrixInverse'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const pDeterminant = args[1] >>> 0;
        const matrix = readMatrix(args[2] >>> 0);
        if (!pOut || !matrix) return 0;
        const result = invertMatrix4(matrix);
        if (!result) return 0;
        if (pDeterminant && !Mem.writeFloat32(pDeterminant, result.determinant)) return 0;
        return writeMatrix(pOut, result.inverse) ? pOut : 0;
    };

    exports['D3DXMatrixTranspose'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const matrix = readMatrix(args[1] >>> 0);
        if (!pOut || !matrix) return 0;
        const transposed = new Float32Array(16);
        for (let row = 0; row < 4; row++) {
            for (let col = 0; col < 4; col++) transposed[row * 4 + col] = matrix[col * 4 + row];
        }
        return writeMatrix(pOut, transposed) ? pOut : 0;
    };

    const rotationX = (angle: number): Float32Array => {
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        return new Float32Array([
            1, 0, 0, 0,
            0, c, s, 0,
            0, -s, c, 0,
            0, 0, 0, 1,
        ]);
    };

    exports['D3DXMatrixRotationX'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        return writeMatrix(pOut, rotationX(u32AsFloat(args[1]))) ? pOut : 0;
    };

    exports['D3DXMatrixRotationY'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const angle = u32AsFloat(args[1]);
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const m = new Float32Array([
            c, 0, -s, 0,
            0, 1, 0, 0,
            s, 0, c, 0,
            0, 0, 0, 1,
        ]);
        return writeMatrix(pOut, m) ? pOut : 0;
    };

    exports['D3DXMatrixRotationZ'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const angle = u32AsFloat(args[1]);
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const m = new Float32Array([
            c, s, 0, 0,
            -s, c, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
        ]);
        return writeMatrix(pOut, m) ? pOut : 0;
    };

    exports['D3DXMatrixRotationAxis'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const axis = readVec3(args[1] >>> 0);
        if (!pOut || !axis) return 0;
        const length = Math.hypot(axis[0], axis[1], axis[2]);
        if (length === 0) return 0;
        const x = axis[0] / length;
        const y = axis[1] / length;
        const z = axis[2] / length;
        const angle = u32AsFloat(args[2]);
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const t = 1 - c;
        const m = new Float32Array([
            t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
            t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
            t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
            0, 0, 0, 1,
        ]);
        return writeMatrix(pOut, m) ? pOut : 0;
    };

    exports['D3DXMatrixPerspectiveFovLH'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const fovy = u32AsFloat(args[1]);
        const aspect = u32AsFloat(args[2]);
        const zn = u32AsFloat(args[3]);
        const zf = u32AsFloat(args[4]);
        const yScale = 1 / Math.tan(fovy * 0.5);
        const xScale = aspect !== 0 ? yScale / aspect : yScale;
        const m = new Float32Array(16);
        m[0] = xScale;
        m[5] = yScale;
        m[10] = zf / (zf - zn);
        m[11] = 1;
        m[14] = (-zn * zf) / (zf - zn);
        return writeMatrix(pOut, m) ? pOut : 0;
    };

    exports['D3DXMatrixLookAtLH'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const eye = readVec3(args[1] >>> 0);
        const at = readVec3(args[2] >>> 0);
        const up = readVec3(args[3] >>> 0);
        if (!eye || !at || !up) return 0;

        let zx = eye[0] - at[0];
        let zy = eye[1] - at[1];
        let zz = eye[2] - at[2];
        let len = Math.hypot(zx, zy, zz);
        if (len === 0) return 0;
        zx /= len; zy /= len; zz /= len;

        let xx = up[1] * zz - up[2] * zy;
        let xy = up[2] * zx - up[0] * zz;
        let xz = up[0] * zy - up[1] * zx;
        len = Math.hypot(xx, xy, xz);
        if (len === 0) return 0;
        xx /= len; xy /= len; xz /= len;

        const yx = zy * xz - zz * xy;
        const yy = zz * xx - zx * xz;
        const yz = zx * xy - zy * xx;

        const m = new Float32Array([
            xx, yx, zx, 0,
            xy, yy, zy, 0,
            xz, yz, zz, 0,
            -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
            -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
            -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
            1,
        ]);
        return writeMatrix(pOut, m) ? pOut : 0;
    };

    exports['D3DXVec3Normalize'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const v = readVec3(args[1] >>> 0);
        if (!v) return 0;
        const len = Math.hypot(v[0], v[1], v[2]);
        if (len === 0) return 0;
        return writeVec3(pOut, v[0] / len, v[1] / len, v[2] / len) ? pOut : 0;
    };

    exports['D3DXVec3TransformCoord'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const v = readVec3(args[1] >>> 0);
        const m = readMatrix(args[2] >>> 0);
        if (!v || !m) return 0;
        const x = v[0] * m[0] + v[1] * m[4] + v[2] * m[8] + m[12];
        const y = v[0] * m[1] + v[1] * m[5] + v[2] * m[9] + m[13];
        const z = v[0] * m[2] + v[1] * m[6] + v[2] * m[10] + m[14];
        const w = v[0] * m[3] + v[1] * m[7] + v[2] * m[11] + m[15];
        if (w === 0) return 0;
        return writeVec3(pOut, x / w, y / w, z / w) ? pOut : 0;
    };

    exports['D3DXVec3TransformCoordArray'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const outStride = args[1] >>> 0;
        const pIn = args[2] >>> 0;
        const inStride = args[3] >>> 0;
        const matrix = readMatrix(args[4] >>> 0);
        const count = args[5] >>> 0;
        if (!pOut || !pIn || !matrix || outStride < 12 || inStride < 12) return 0;
        for (let i = 0; i < count; i++) {
            const v = readVec3(pIn + i * inStride);
            if (!v) return 0;
            const transformed = transformVec4([v[0], v[1], v[2], 1], matrix);
            if (transformed[3] === 0) return 0;
            if (!writeVec3(
                pOut + i * outStride,
                transformed[0] / transformed[3],
                transformed[1] / transformed[3],
                transformed[2] / transformed[3],
            )) return 0;
        }
        return pOut;
    };

    exports['D3DXVec3Transform'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const v = readVec3(args[1] >>> 0);
        const matrix = readMatrix(args[2] >>> 0);
        if (!pOut || !v || !matrix) return 0;
        const result = transformVec4([v[0], v[1], v[2], 1], matrix);
        return writeVec4(pOut, ...result) ? pOut : 0;
    };

    exports['D3DXVec4Transform'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const v = readVec4(args[1] >>> 0);
        const matrix = readMatrix(args[2] >>> 0);
        if (!pOut || !v || !matrix) return 0;
        const result = transformVec4(v, matrix);
        return writeVec4(pOut, ...result) ? pOut : 0;
    };

    exports['D3DXVec3CatmullRom'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const v0 = readVec3(args[1] >>> 0);
        const v1 = readVec3(args[2] >>> 0);
        const v2 = readVec3(args[3] >>> 0);
        const v3 = readVec3(args[4] >>> 0);
        if (!pOut || !v0 || !v1 || !v2 || !v3) return 0;
        const s = u32AsFloat(args[5]);
        const s2 = s * s;
        const s3 = s2 * s;
        const component = (i: number) => 0.5 * (
            2 * v1[i] + (v2[i] - v0[i]) * s
            + (2 * v0[i] - 5 * v1[i] + 4 * v2[i] - v3[i]) * s2
            + (v3[i] - 3 * v2[i] + 3 * v1[i] - v0[i]) * s3
        );
        return writeVec3(pOut, component(0), component(1), component(2)) ? pOut : 0;
    };

    exports['D3DXQuaternionSlerp'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const q1 = readVec4(args[1] >>> 0);
        const q2Input = readVec4(args[2] >>> 0);
        if (!pOut || !q1 || !q2Input) return 0;
        const q2 = [...q2Input];
        let dot = q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3];
        if (dot < 0) {
            dot = -dot;
            for (let i = 0; i < 4; i++) q2[i] = -q2[i];
        }
        dot = Math.min(1, Math.max(-1, dot));
        const t = u32AsFloat(args[3]);
        let a = 1 - t;
        let b = t;
        if (dot < 0.9995) {
            const omega = Math.acos(dot);
            const sinOmega = Math.sin(omega);
            a = Math.sin((1 - t) * omega) / sinOmega;
            b = Math.sin(t * omega) / sinOmega;
        }
        return writeVec4(
            pOut,
            a * q1[0] + b * q2[0],
            a * q1[1] + b * q2[1],
            a * q1[2] + b * q2[2],
            a * q1[3] + b * q2[3],
        ) ? pOut : 0;
    };

    exports['D3DXPlaneFromPointNormal'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const point = readVec3(args[1] >>> 0);
        const normal = readVec3(args[2] >>> 0);
        if (!pOut || !point || !normal) return 0;
        const d = -(point[0] * normal[0] + point[1] * normal[1] + point[2] * normal[2]);
        return writeVec4(pOut, normal[0], normal[1], normal[2], d) ? pOut : 0;
    };

    exports['D3DXPlaneIntersectLine'] = (_ctx, _mem, args) => {
        const pOut = args[0] >>> 0;
        const pPlane = args[1] >>> 0;
        const pv1 = args[2] >>> 0;
        const pv2 = args[3] >>> 0;
        if (!pOut || !pPlane || !pv1 || !pv2) return 0;

        const a = Mem.readFloat32(pPlane);
        const b = Mem.readFloat32(pPlane + 4);
        const c = Mem.readFloat32(pPlane + 8);
        const d = Mem.readFloat32(pPlane + 12);
        const v1 = readVec3(pv1);
        const v2 = readVec3(pv2);
        if (a === null || b === null || c === null || d === null || !v1 || !v2) return 0;

        const dx = v2[0] - v1[0];
        const dy = v2[1] - v1[1];
        const dz = v2[2] - v1[2];
        const denom = a * dx + b * dy + c * dz;
        if (Math.abs(denom) < 1e-8) {
            writeVec3(pOut, 0, 0, 0);
            return 0;
        }
        const t = -(a * v1[0] + b * v1[1] + c * v1[2] + d) / denom;
        writeVec3(pOut, v1[0] + dx * t, v1[1] + dy * t, v1[2] + dz * t);
        return pOut;
    };

    return exports;
}
