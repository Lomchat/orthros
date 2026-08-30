import type { LibDescriptor } from '../../types';
import { HANDLER_FTOL } from '../../../cpu/hypercall-data';
import { msvcEmbeddedFtol2Handler } from './ftol2';

function hexBytes(hex: string): Uint8Array {
    const compact = hex.replace(/\s+/g, '');
    const out = new Uint8Array(compact.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
    return out;
}

// Classic statically-linked MSVC `_ftol2_sse`. Match the complete function,
// including both signed correction branches and the final LEAVE/RET, so a
// compiler-generated lookalike cannot be patched on a short x87 sequence.
const FTOL2_SSE_PATTERN = hexBytes(
    '558bec83ec2083e4f0 d9c0 d9542418 df7c2410 df6c2410 ' +
    '8b542418 8b442410 85c0 743c dee9 85d2 791e ' +
    'd91c24 8b0c24 81f100000080 81c1ffffff7f 83d000 ' +
    '8b542414 83d200 eb2c ' +
    'd91c24 8b0c24 81c1ffffff7f 83d800 8b542414 83da00 eb14 ' +
    '8b542414 f7c2ffffff7f 75b8 d95c2418 d95c2418 c9c3',
);

export const msvcEmbeddedDescriptor: LibDescriptor = {
    id: 'msvc-embedded',
    displayName: 'Statically linked Microsoft C/C++ runtime intrinsics',
    minConfidence: 16,
    signatures: {
        ftol2_sse: {
            kind: 'bytes',
            pattern: FTOL2_SSE_PATTERN,
            mask: 'x'.repeat(FTOL2_SSE_PATTERN.length),
            section: '.text',
            weight: 16,
        },
    },
    functions: {
        ftol2_sse: {
            name: 'ftol2_sse',
            entryProbe: {
                kind: 'prologue',
                pattern: FTOL2_SSE_PATTERN,
                mask: 'x'.repeat(FTOL2_SSE_PATTERN.length),
                section: '.text',
            },
            callingConvention: 'cdecl',
            argCount: 0,
            required: true,
            hypercallHandlerId: HANDLER_FTOL,
        },
    },
    handlers: {
        ftol2_sse: msvcEmbeddedFtol2Handler,
    },
};
