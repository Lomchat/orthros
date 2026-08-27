// Trap-free kernel32!GetLastError / SetLastError leaves.

/**
 * Replace generated 16-byte OUT-trap stubs that belong to this materialization
 * batch with direct accesses to the standard per-thread TEB LastErrorValue at
 * FS:[0x34].
 *
 * Unlike the HYPERCALL_PAGE (a Rust static below guest RAM), the TEB is directly
 * guest-addressable and already follows the active thread through FS. The
 * scheduler and WASM SetLastError path keep the same TEB field synchronized, so
 * these leaves remove two extremely hot x86 -> host boundaries without baking a
 * host-linear address into guest code.
 */
export function patchLastErrorInlineStubs(
    code: Uint8Array,
    codeBase: number,
    getLastErrorAddress: number | undefined,
    setLastErrorAddress: number | undefined,
    _hypercallPageBase: number,
): { getLastError: boolean; setLastError: boolean } {
    const result = { getLastError: false, setLastError: false };
    if (code.length === 0) return result;
    const end = (codeBase + code.length) >>> 0;

    const patch = (address: number | undefined, bytes: number[]): boolean => {
        if (address === undefined || address < codeBase || address >= end) return false;
        const offset = address - codeBase;
        if (offset < 0 || offset + 16 > code.length) return false;
        code.fill(0x90, offset, offset + 16);
        code.set(bytes, offset);
        return true;
    };
    // DWORD GetLastError(void): mov eax,fs:[0x34]; ret
    result.getLastError = patch(getLastErrorAddress, [
        0x64, 0xa1, 0x34, 0x00, 0x00, 0x00,
        0xc3,
    ]);

    // void SetLastError(DWORD e):
    //   mov eax,[esp+4]; mov fs:[0x34],eax; xor eax,eax; ret 4
    // EAX/flags are volatile under stdcall; returning zero matches the old thunk.
    result.setLastError = patch(setLastErrorAddress, [
        0x8b, 0x44, 0x24, 0x04,
        0x64, 0xa3, 0x34, 0x00, 0x00, 0x00,
        0x31, 0xc0,
        0xc2, 0x04, 0x00,
    ]);

    return result;
}
