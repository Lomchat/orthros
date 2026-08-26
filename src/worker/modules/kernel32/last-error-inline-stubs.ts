// Trap-free kernel32!GetLastError / SetLastError leaves.

/**
 * Replace generated 16-byte OUT-trap stubs that belong to this materialization
 * batch with direct accesses to the per-thread last-error slot on the shared
 * hypercall page.
 *
 * The scheduler already swaps this slot on every guest-thread context switch,
 * copies it back when switching out, and updates it whenever a JS Win32 thunk
 * calls scheduler.setLastError(). Keeping this slot authoritative therefore
 * preserves the existing cross-tier semantics while removing two extremely hot
 * x86 -> JS/WASM boundaries.
 */
export function patchLastErrorInlineStubs(
    code: Uint8Array,
    codeBase: number,
    getLastErrorAddress: number | undefined,
    setLastErrorAddress: number | undefined,
    hypercallPageBase: number,
): { getLastError: boolean; setLastError: boolean } {
    const result = { getLastError: false, setLastError: false };
    if (!hypercallPageBase || code.length === 0) return result;

    // Keep this in sync with OFF_HC_LAST_ERROR in cpu/hypercall-data.ts. It is
    // intentionally encoded here rather than exported as mutable runtime state:
    // the generated x86 leaf needs the absolute guest address baked into imm32.
    const lastErrorAddress = (hypercallPageBase + 0x024) >>> 0;
    const end = (codeBase + code.length) >>> 0;

    const patch = (address: number | undefined, bytes: number[]): boolean => {
        if (address === undefined || address < codeBase || address >= end) return false;
        const offset = address - codeBase;
        if (offset < 0 || offset + 16 > code.length) return false;
        code.fill(0x90, offset, offset + 16);
        code.set(bytes, offset);
        return true;
    };
    const imm32 = (value: number) => [
        value & 0xff,
        (value >>> 8) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 24) & 0xff,
    ];

    // DWORD GetLastError(void): mov eax,[lastError]; ret
    result.getLastError = patch(getLastErrorAddress, [
        0xa1, ...imm32(lastErrorAddress),
        0xc3,
    ]);

    // void SetLastError(DWORD e):
    //   mov eax,[esp+4]; mov [lastError],eax; xor eax,eax; ret 4
    // EAX/flags are volatile under stdcall; returning zero matches the old thunk.
    result.setLastError = patch(setLastErrorAddress, [
        0x8b, 0x44, 0x24, 0x04,
        0xa3, ...imm32(lastErrorAddress),
        0x31, 0xc0,
        0xc2, 0x04, 0x00,
    ]);

    return result;
}
