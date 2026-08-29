import { describe, expect, test } from 'bun:test';
import { HANDLER_FTOL } from '../../src/worker/core/cpu/hypercall-data';
import { msvcEmbeddedDescriptor } from '../../src/worker/core/hle-lib/libs/msvc-embedded/descriptor';
import { ftol2SseHalves } from '../../src/worker/core/hle-lib/libs/msvc-embedded/ftol2';

describe('embedded MSVC _ftol2_sse HLE', () => {
    test('matches the complete routine and routes it to the generic WASM converter', () => {
        const signature = msvcEmbeddedDescriptor.signatures.ftol2_sse;
        expect(signature.kind).toBe('bytes');
        if (signature.kind !== 'bytes') throw new Error('unexpected signature kind');
        expect(signature.pattern.length).toBeGreaterThan(100);
        expect(signature.mask).toBe('x'.repeat(signature.pattern.length));
        expect(signature.pattern.slice(-2)).toEqual(Uint8Array.of(0xc9, 0xc3));
        expect(msvcEmbeddedDescriptor.minConfidence).toBe(signature.weight);
        expect(msvcEmbeddedDescriptor.functions.ftol2_sse.argCount).toBe(0);
        expect(msvcEmbeddedDescriptor.functions.ftol2_sse.callingConvention).toBe('cdecl');
        expect(msvcEmbeddedDescriptor.functions.ftol2_sse.hypercallHandlerId).toBe(HANDLER_FTOL);
    });

    test('preserves full signed 64-bit truncation and x87 indefinite results', () => {
        expect(ftol2SseHalves(3.9)).toEqual({ low: 3, high: 0 });
        expect(ftol2SseHalves(-3.9)).toEqual({ low: 0xffff_fffd, high: -1 });
        expect(ftol2SseHalves(4_294_967_297)).toEqual({ low: 1, high: 1 });
        expect(ftol2SseHalves(Number.NaN)).toEqual({ low: 0, high: -0x8000_0000 });
    });
});
