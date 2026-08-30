import { describe, expect, test } from 'bun:test';
import { HANDLER_MSVC_EH_PROLOG } from '../../src/worker/core/cpu/hypercall-data';
import { msvcEmbeddedDescriptor } from '../../src/worker/core/hle-lib/libs/msvc-embedded/descriptor';
import {
    assembleMsvcEhPrologWrapper,
    computeMsvcEhPrologTransition,
} from '../../src/worker/core/hle-lib/libs/msvc-embedded/eh-prolog';

function readU32(mem: Uint8Array, address: number): number | null {
    if (address < 0 || address + 4 > mem.length) return null;
    return new DataView(mem.buffer).getUint32(address, true);
}

function writeU32(mem: Uint8Array, address: number, value: number): void {
    new DataView(mem.buffer).setUint32(address, value >>> 0, true);
}

describe('embedded MSVC _EH_prolog HLE', () => {
    test('requires the exact complete helper and routes it to generic handler 84', () => {
        const signature = msvcEmbeddedDescriptor.signatures.eh_prolog;
        expect(signature.kind).toBe('bytes');
        if (signature.kind !== 'bytes') throw new Error('unexpected signature kind');
        expect(signature.pattern.length).toBe(31);
        expect(signature.mask).toBe('x'.repeat(31));
        expect(signature.pattern.slice(-6)).toEqual(Uint8Array.of(0x8d, 0x6c, 0x24, 0x0c, 0x50, 0xc3));

        const fn = msvcEmbeddedDescriptor.functions.eh_prolog;
        expect(fn.prologueLen).toBe(9);
        expect(fn.argCount).toBe(0);
        expect(fn.callingConvention).toBe('cdecl');
        expect(fn.hypercallHandlerId).toBe(HANDLER_MSVC_EH_PROLOG);
    });

    test('wrapper preserves incoming EAX and tail-jumps to the stub', () => {
        const code = assembleMsvcEhPrologWrapper(0x1000, 0x2340);
        expect(code).toEqual(Uint8Array.of(0x50, 0xe9, 0x3a, 0x13, 0x00, 0x00));
    });

    test('reconstructs the exact stack, SEH link, EBP and EAX of the original helper', () => {
        const mem = new Uint8Array(0x20_000);
        const callerEsp = 0x18_000;
        const savedEsp = callerEsp - 4; // wrapper already executed PUSH EAX
        const fsBase = 0x1_000;
        const oldEbp = 0x1234_5678;
        const handler = 0x00ab_cdef;
        const returnAddress = 0x0040_1234;
        const oldSeh = 0x17_000;
        writeU32(mem, savedEsp, handler);
        writeU32(mem, callerEsp, returnAddress);
        writeU32(mem, fsBase, oldSeh);

        const transition = computeMsvcEhPrologTransition(
            savedEsp, oldEbp, fsBase, address => readU32(mem, address),
        );
        expect(transition).not.toBeNull();
        if (!transition) throw new Error('transition unexpectedly rejected');

        writeU32(mem, transition.wrapperRetSlot, transition.returnAddress);
        writeU32(mem, transition.frame, transition.oldSeh);
        writeU32(mem, transition.frame + 4, transition.handler);
        writeU32(mem, transition.frame + 8, 0xffff_ffff);
        writeU32(mem, transition.frame + 12, transition.oldEbp);
        writeU32(mem, fsBase, transition.frame);

        // The wrapper/stub RET consumes wrapperRetSlot. These are the exact
        // values after the original `_EH_prolog` RET.
        const finalEsp = transition.wrapperRetSlot + 4;
        expect(finalEsp).toBe(callerEsp - 12);
        expect(transition.callerEsp).toBe(callerEsp);
        expect(transition.returnAddress).toBe(returnAddress);
        expect(readU32(mem, fsBase)).toBe(callerEsp - 12);
        expect(readU32(mem, finalEsp)).toBe(oldSeh);
        expect(readU32(mem, finalEsp + 4)).toBe(handler);
        expect(readU32(mem, finalEsp + 8)).toBe(0xffff_ffff);
        expect(readU32(mem, finalEsp + 12)).toBe(oldEbp);
    });

    test('rejects missing FS or unreadable input without a partial plan', () => {
        expect(computeMsvcEhPrologTransition(0x1000, 0, 0, () => 0)).toBeNull();
        expect(computeMsvcEhPrologTransition(0x1000, 0, 0x2000, () => null)).toBeNull();
    });
});
