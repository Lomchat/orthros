/**
 * Reinterpret a 32-bit DWORD's bit pattern as an IEEE-754 float — used where the
 * guest passes a float bit-encoded in a render-state DWORD (e.g. D3D fog start/end/
 * density). Module-level scratch avoids a per-call ArrayBuffer + DataView allocation.
 */

const _dwordBuf = new ArrayBuffer(4);
const _dwordView = new DataView(_dwordBuf);

export function dwordToFloat(dword: number): number {
    _dwordView.setUint32(0, dword >>> 0, true);
    return _dwordView.getFloat32(0, true);
}
