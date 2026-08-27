import type { LibDescriptor } from '../../types';
import {
    HANDLER_BFME_FOLD33_HASH,
    HANDLER_BFME_STRING_ASSIGN,
    HANDLER_BFME_STRING_COPY,
    HANDLER_BFME_STRING_LOWER,
    HANDLER_BFME_STRING_RELEASE,
    HANDLER_BFME_MATRIX_POP,
    HANDLER_BFME_MATRIX_PUSH,
    HANDLER_BFME_MATRIX_MULTIPLY,
    HANDLER_BFME_TRANSFORM_PUSH,
    HANDLER_BFME_TRANSFORM_POP,
    HANDLER_BFME_MATRIX_ADJUST,
    HANDLER_BFME_TREE_SUCCESSOR,
    HANDLER_BFME_VERTEX_BLEND,
    HANDLER_BFME_JPEG_IDCT_ISLOW,
    HANDLER_BFME_PIXEL_ALPHA_BLEND,
} from '../../../cpu/hypercall-data';
import { bfmeFold33HashKernel } from './hash';
import { buildBfmeStringLowerFilter } from './string-lower-filter';
import { bfmeStringLowerHandler } from './string-lower';
import {
    buildBfmeStringAssignFilter,
    buildBfmeStringCopyFilter,
    buildBfmeStringReleaseFilter,
} from './string-ref-filter';
import {
    bfmeStringAssignHandler,
    bfmeStringCopyHandler,
    bfmeStringReleaseHandler,
} from './string-ref';
import {
    bfmeMatrixPopHandler,
    bfmeMatrixPushHandler,
    bfmeTransformPopHandler,
    bfmeTransformPushHandler,
} from './matrix-stack';
import { bfmeMatrixAdjustHandler, bfmeMatrixMultiplyHandler } from './matrix-multiply';
import { buildMatrixAdjustWrapper, buildTransformPopWrapper } from './matrix-callback-wrappers';
import {
    bfmeSmallPoolUnreachableHandler,
    buildBfmeSmallPoolAllocInline,
    buildBfmeSmallPoolFreeInline,
} from './small-pool-inline';
import { bfmeTreeSuccessorHandler } from './tree-successor';
import { buildBfmeVertexBlendWrapper, bfmeVertexBlendFallbackHandler } from './vertex-blend';
import { bfmeJpegIdctShadow } from './jpeg-idct-islow';
import { buildBfmeVectorCtorFilter, bfmeVectorCtorUnreachableHandler } from './vector-ctor-filter';
import { bfmePixelAlphaBlendShadow } from './pixel-alpha-blend';

function hexBytes(hex: string): Uint8Array {
    const compact = hex.replace(/\s+/g, '');
    const out = new Uint8Array(compact.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
    return out;
}

// lotrbfme.exe 1.03 FR @ 0x0048f3c0. This pure leaf hashes resource/path names
// case-insensitively and calls MSVCR71!tolower once per byte. The player trace
// measured 121,502 loop calls plus 1.11M native-CRT blocks in ten seconds.
const FOLD33_PATTERN = hexBytes(
    '56 57 8b7c240c 8a07 33f6 84c0 741e 53 8b1dfc943501 ' +
    '0fbec0 50 ffd3 6bf621 03f0 8a4701 83c404 47 84c0 75ea ' +
    '5b 5f 8bc6 5e c3',
);

// lotrbfme.exe 1.03 FR @ 0x00c87da0 — stringbase<char>::tolower().
// The guest filter only selects its allocation-free, uniquely-owned branch.
const STRING_LOWER_PATTERN = hexBytes(
    '51 53 8bd9 8b03 85c0 0f84d4000000 0fb74804 0fb75006 3bd1 56 57 ' +
    '7e0f 833801 750a c644010800 e990000000',
);

// Three adjacent MSVC stringbase<char> reference helpers. A 12-second
// escarmouche trace measured 105,651 releases, 34,097 copy constructions and
// 24,901 assignments. Their original implementations enter the same global
// lock around even null/shared-buffer operations.
const STRING_RELEASE_PATTERN = hexBytes(
    '568bf18a0d2c6e3301b80100000084c8752b8b0d2c6e33010bc868106e3301' +
    '890d2c6e3301a2286e3301ff154c8e350168e00e0701e8acf4160083c404' +
    'a0286e330184c0740b68106e3301ff15188d35018b0685c07419ff088b06' +
    '833800750a50ff15d493350183c404c70600000000a0286e330184c05e740b' +
    '68106e3301ff15748e3501c3',
);
const STRING_COPY_PATTERN = hexBytes(
    '568bf18a0d2c6e3301b80100000084c8752b8b0d2c6e33010bc868106e3301' +
    '890d2c6e3301a2286e3301ff154c8e350168e00e0701e88cf2160083c404' +
    'a0286e330184c0740b68106e3301ff15188d35018b4424088b0085c089067402' +
    'ff00a0286e330184c0740b68106e3301ff15748e35018bc65ec20400',
);
const STRING_ASSIGN_PATTERN = hexBytes(
    '568bf18a0d2c6e3301b80100000084c857752b8b3d2c6e33010bf868106e3301' +
    '893d2c6e3301a2286e3301ff154c8e350168e00e0701e85bf1160083c404' +
    'a0286e330184c0740b68106e3301ff15188d35018b7c240c3bfe74118bce' +
    'e84ffcffff8b0785c089067402ff00a0286e330184c05f5e740ec7442404106e' +
    '3301ff25748e3501c20400',
);

// STLPort's hot eight-byte-class pool at 0x00c2e540/0x00c2e5f0. The original
// wraps every freelist pop/push in a generic spin lock and SEH frame. The
// generated guest-native wrappers preserve the lock word and fall back to the
// exact original allocator when a class is empty or temporarily busy.
const SMALL_POOL_ALLOC_PATTERN = hexBytes(
    '558bec6aff687849050164a100000000506489250000000083ec148b450883e801' +
    'c1e8038d0c85c0b13001894df0ba0100000085d2740ab954b23001e88ff4ffff' +
    'c745fc000000008b45f08b08894dec837dec00740c8b55f08b45ec8b08890aeb0f' +
    '8b550852e875e3ffff83c4048945ec8b45ec8945e4c745fcffffffffb901000000' +
    '85c9740ab954b23001e87fc7ffff8b45e48b4df464890d000000008be55dc3',
);
const SMALL_POOL_FREE_PATTERN = hexBytes(
    '558bec83ec0c8b450c83e801c1e8038d0c85c0b13001894dfcba0100000085d2' +
    '740ab954b23001e8f4f3ffff8b45088b4dfc8b1189108b45fc8b4d088908ba01' +
    '00000085d2740ab954b23001e80fc7ffff8be55dc3',
);

// lotrbfme.exe 1.03 FR @ 0x00cd2b50 / 0x00cd2b80. These leaves push and
// pop the current 32-byte matrix state from the object's inline stack. Their
// REP MOVSD instructions force JIT exits even though ECX is always eight.
const MATRIX_PUSH_PATTERN = hexBytes(
    '8bc1 8b88b8030000 56 c1e105 57 8d7c0138 b908000000 8bf0 f3a5 ' +
    '8b88b8030000 41 5f 8988b8030000 5e c3',
);
const MATRIX_POP_PATTERN = hexBytes(
    '56 57 8bf9 8bb7b8030000 4e 8bc6 89b7b8030000 c1e005 ' +
    '8d743838 b908000000 f3a5 5f 5e c3',
);

// lotrbfme.exe 1.03 FR @ 0x00cd2d10. This 2D affine-matrix composition
// snapshots two six-float inputs, computes six x87 results and writes a third
// six-float matrix. It was the hottest remaining long block after push/pop HLE.
const MATRIX_MULTIPLY_PATTERN = hexBytes(
    '83ec30 8b442434 8b08 8b5004 890c24 8b4808 89542404 8b500c ' +
    '894c2408 d9442408 8b4810 8954240c 8b5014 8b442438 894c2410 ' +
    '8b08 89542414 8b5004 8954241c d84c241c d90424 894c2418 ' +
    'd84c2418 8b4808 8b500c 894c2420 8b4810 dec1 89542424 ' +
    '8b5014 8b44243c d918 8954242c d944240c 894c2428 d84c241c ' +
    'd9442404 d84c2418 dec1 d95804 d9442424 d84c2408 d9442420 ' +
    'd80c24 dec1 d95808 d9442424 d84c240c d9442420 d84c2404 ' +
    'dec1 d9580c d944242c d84c2408 d9442428 d80c24 dec1 ' +
    'd8442410 d95810 d944242c d84c240c d9442428 d84c2404 ' +
    'dec1 d8442414 d95814 83c430 c3',
);

// lotrbfme.exe 1.03 FR @ 0x00cd2c80. Save the current six-float transform
// from object+0x20 into the 24-byte inline stack and increment its depth.
const TRANSFORM_PUSH_PATTERN = hexBytes(
    '8b81bc030000 8d0440 56 8d84c138020000 8d5120 ' +
    '8b32 8930 8b7204 897004 8b7208 897008 8b720c 89700c ' +
    '8b7210 897010 8b5214 895014 ff81bc030000 5e c3',
);
const TRANSFORM_POP_PATTERN = hexBytes(
    '8b91bc030000 4a 8991bc030000 8bc2 8d5120 8d0440 ' +
    '8d8cc138020000 56 8b31 8bc2 8930 8b7104 897004 ' +
    '8b7108 897008 8b710c 89700c 8b7110 897010 8b4914 ' +
    '52 894814 ff15a0783301 83c404 5e c3',
);
const MATRIX_ADJUST_PATTERN = hexBytes(
    '8b442404 d900 51 d809 d919 d94004 d84904 d95904 ' +
    'd94008 d84908 d95908 d9400c d8490c d9590c ' +
    'd94010 d84110 d95910 d94014 d84114 d95914 ' +
    'd94018 d84118 d95918 d9401c d8411c d9591c ' +
    'ff15a4783301 59 c20400',
);
// lotrbfme.exe 1.03 FR @ 0x00c2b870. STL tree iterator successor:
// descend to the leftmost node of the right subtree, otherwise ascend parents.
// A five-second escarmouche trace measured ~32K calls/s and 1.43M tiny JIT
// blocks on this page.
const TREE_SUCCESSOR_PATTERN = hexBytes(
    '558bec51 8b4508 83780c00 741f 8b4d08 8b510c 895508 ' +
    '8b4508 83780800 740b 8b4d08 8b5108 895508 ebec eb36 ' +
    '8b4508 8b4804 894dfc 8b55fc 8b4508 3b420c 7511 ' +
    '8b4dfc 894d08 8b55fc 8b4204 8945fc ebe4 8b4d08 ' +
    '8b510c 3b55fc 7406 8b45fc 894508 8b4508 8be5 5d c3',
);

// lotrbfme.exe 1.03 FR @ 0x00e2dc30. This is an inner loop rather than a
// callable leaf: it adds four float4 streams, applies one scalar weight and
// writes the output. During cold Dunharrow construction it executed 850,432
// iterations in twelve seconds and dominated 2.25-second v86 frames.
const VERTEX_BLEND_PATTERN = hexBytes(
    '8b45f0 d9056c3b0801 8945ec 8b45e8 8b4dfc 8d3412 c1e604 03c6 ' +
    'd900 03ce d801 8b7dec d94004 8345ec10 d84104 d94008 d84108',
);

// lotrbfme.exe 1.03 FR @ 0x00ed1aa0. This is IJG's integer 8x8
// jpeg_idct_islow, statically linked into the executable. Cold map loading
// decodes tens of thousands of blocks through this 3.2 KiB x86 function.
const JPEG_IDCT_ISLOW_PATTERN = hexBytes(
    '81ec3c010000 8b842440010000 8b942444010000 8b8848010000 53 ' +
    '8b5a50 55 8bac2450010000 56 57 81c180000000 896c2434',
);

// lotrbfme.exe 1.03 FR @ 0x0045c600: MSVC vector-constructor iterator.
// During cold map construction, almost all calls target one of seven exact
// no-op constructors; the guest filter returns immediately only for those.
const VECTOR_CTOR_ITER_PATTERN = hexBytes(
    '8b44240c 48 7826 53 8b5c2414 55 8b6c2410 56 8b742410 57 ' +
    '8d7801 8d9b00000000 8bce ffd3 03f5 4f 75f7 5f5e5d5b c21000',
);

// lotrbfme.exe 1.03 FR @ 0x00b47940. Integer software alpha blend over a
// contiguous BGRA span. A cold-load trace measured 754,816 pixel iterations
// and more than three million JIT block executions in ten seconds.
const PIXEL_ALPHA_BLEND_PATTERN = hexBytes(
    '558bec515356578b451485c00f8e9b0000008945fc8b45088b088b45100fb630' +
    'bfff0000002bfe83c0048945108b450c8b1033c08ac10fafc6c1f80833db8ada' +
    '0fafdfc1fb0803c38ad0c1ca08c1c90833c08ac10fafc6c1f80833db8ada0faf' +
    'dfc1fb0803c38ad0c1ca08c1c90833c08ac10fafc6c1f80833db8ada0fafdfc1' +
    'fb0803c38ad0c1ca10c1c9108b450c891083c00489450c8b450883c004894508' +
    '8b45fc488945fc0f8568ffffff5f5e5b8be55dc3',
);


export const bfmeDescriptor: LibDescriptor = {
    id: 'bfme',
    displayName: 'BFME 1.03 hot inner loops',
    minConfidence: 12,
    signatures: {
        fold33_hash: {
            kind: 'bytes',
            pattern: FOLD33_PATTERN,
            mask: 'x'.repeat(FOLD33_PATTERN.length),
            section: '.text',
            weight: 12,
        },
        string_lower: {
            kind: 'bytes',
            pattern: STRING_LOWER_PATTERN,
            mask: 'x'.repeat(STRING_LOWER_PATTERN.length),
            section: '.text',
            weight: 12,
        },
        string_release: {
            kind: 'bytes', pattern: STRING_RELEASE_PATTERN,
            mask: 'x'.repeat(STRING_RELEASE_PATTERN.length), section: '.text', weight: 12,
        },
        string_copy: {
            kind: 'bytes', pattern: STRING_COPY_PATTERN,
            mask: 'x'.repeat(STRING_COPY_PATTERN.length), section: '.text', weight: 12,
        },
        string_assign: {
            kind: 'bytes', pattern: STRING_ASSIGN_PATTERN,
            mask: 'x'.repeat(STRING_ASSIGN_PATTERN.length), section: '.text', weight: 12,
        },
        small_pool_alloc: {
            kind: 'bytes', pattern: SMALL_POOL_ALLOC_PATTERN,
            mask: 'x'.repeat(SMALL_POOL_ALLOC_PATTERN.length), section: '.text', weight: 12,
        },
        small_pool_free: {
            kind: 'bytes', pattern: SMALL_POOL_FREE_PATTERN,
            mask: 'x'.repeat(SMALL_POOL_FREE_PATTERN.length), section: '.text', weight: 12,
        },
        matrix_push: {
            kind: 'bytes', pattern: MATRIX_PUSH_PATTERN,
            mask: 'x'.repeat(MATRIX_PUSH_PATTERN.length), section: '.text', weight: 12,
        },
        matrix_pop: {
            kind: 'bytes', pattern: MATRIX_POP_PATTERN,
            mask: 'x'.repeat(MATRIX_POP_PATTERN.length), section: '.text', weight: 12,
        },
        matrix_multiply: {
            kind: 'bytes', pattern: MATRIX_MULTIPLY_PATTERN,
            mask: 'x'.repeat(MATRIX_MULTIPLY_PATTERN.length), section: '.text', weight: 12,
        },
        transform_push: {
            kind: 'bytes', pattern: TRANSFORM_PUSH_PATTERN,
            mask: 'x'.repeat(TRANSFORM_PUSH_PATTERN.length), section: '.text', weight: 12,
        },
        transform_pop: {
            kind: 'bytes', pattern: TRANSFORM_POP_PATTERN,
            mask: 'x'.repeat(TRANSFORM_POP_PATTERN.length), section: '.text', weight: 12,
        },
        matrix_adjust: {
            kind: 'bytes', pattern: MATRIX_ADJUST_PATTERN,
            mask: 'x'.repeat(MATRIX_ADJUST_PATTERN.length), section: '.text', weight: 12,
        },
        tree_successor: {
            kind: 'bytes', pattern: TREE_SUCCESSOR_PATTERN,
            mask: 'x'.repeat(TREE_SUCCESSOR_PATTERN.length), section: '.text', weight: 12,
        },
        vertex_blend: {
            kind: 'bytes', pattern: VERTEX_BLEND_PATTERN,
            mask: 'x'.repeat(VERTEX_BLEND_PATTERN.length), section: '.text', weight: 12,
        },
        jpeg_idct_islow: {
            kind: 'bytes', pattern: JPEG_IDCT_ISLOW_PATTERN,
            mask: 'x'.repeat(JPEG_IDCT_ISLOW_PATTERN.length), section: '.text', weight: 12,
        },
        vector_ctor_iter: {
            kind: 'bytes', pattern: VECTOR_CTOR_ITER_PATTERN,
            mask: 'x'.repeat(VECTOR_CTOR_ITER_PATTERN.length), section: '.text', weight: 12,
        },
        pixel_alpha_blend: {
            kind: 'bytes', pattern: PIXEL_ALPHA_BLEND_PATTERN,
            mask: 'x'.repeat(PIXEL_ALPHA_BLEND_PATTERN.length), section: '.text', weight: 12,
        },
    },
    functions: {
        fold33_hash: {
            name: 'fold33_hash',
            entryProbe: {
                kind: 'prologue',
                pattern: FOLD33_PATTERN,
                mask: 'x'.repeat(FOLD33_PATTERN.length),
                section: '.text',
            },
            callingConvention: 'cdecl',
            argCount: 1,
            required: true,
            // push esi; push edi; mov edi,[esp+0xc]
            prologueLen: 6,
            hypercallHandlerId: HANDLER_BFME_FOLD33_HASH,
            shadow: {
                // Pure leaf with a byte-exact, title/version-specific signature.
                // Keep this kernel-live so the WASM handler is armed immediately:
                // the original intentionally calls our THUNK_CODE-resident inline
                // MSVCR71!tolower leaf, which makes the generic sync validator
                // report a structural `thunk-entry` even though no host thunk or
                // side effect is involved. The exact VC7 default-locale behavior
                // (including signed bytes) is pinned by the unit tests below.
                validateInGame: false,
                guard(args, view) {
                    const base = args[0] >>> 0;
                    if (base === 0) return false;
                    try {
                        for (let i = 0; i < 4096; i++) {
                            if (view.readU8((base + i) >>> 0) === 0) return true;
                        }
                    } catch {
                        return false;
                    }
                    return false;
                },
                ranges() { return []; },
                kernel: bfmeFold33HashKernel,
            },
        },
        string_lower: {
            name: 'string_lower',
            entryProbe: {
                kind: 'prologue',
                pattern: STRING_LOWER_PATTERN,
                mask: 'x'.repeat(STRING_LOWER_PATTERN.length),
                section: '.text',
            },
            // __thiscall, no stack arguments and a plain RET. ECX is preserved
            // by both the filter and the OUT stub and read by handler 136.
            callingConvention: 'cdecl',
            argCount: 0,
            required: true,
            // push ecx; push ebx; mov ebx,ecx; mov eax,[ebx]
            prologueLen: 6,
            hypercallHandlerId: HANDLER_BFME_STRING_LOWER,
            entryFilter: buildBfmeStringLowerFilter,
        },
        string_release: {
            name: 'string_release',
            entryProbe: { kind: 'prologue', pattern: STRING_RELEASE_PATTERN, mask: 'x'.repeat(STRING_RELEASE_PATTERN.length), section: '.text' },
            callingConvention: 'cdecl', argCount: 0, required: true,
            // push esi; mov esi,ecx; mov cl,[0x01336e2c]
            prologueLen: 9,
            hypercallHandlerId: HANDLER_BFME_STRING_RELEASE,
            entryFilter: buildBfmeStringReleaseFilter,
        },
        string_copy: {
            name: 'string_copy',
            entryProbe: { kind: 'prologue', pattern: STRING_COPY_PATTERN, mask: 'x'.repeat(STRING_COPY_PATTERN.length), section: '.text' },
            callingConvention: 'stdcall', argCount: 1, required: true,
            prologueLen: 9,
            hypercallHandlerId: HANDLER_BFME_STRING_COPY,
            entryFilter: buildBfmeStringCopyFilter,
        },
        string_assign: {
            name: 'string_assign',
            entryProbe: { kind: 'prologue', pattern: STRING_ASSIGN_PATTERN, mask: 'x'.repeat(STRING_ASSIGN_PATTERN.length), section: '.text' },
            callingConvention: 'stdcall', argCount: 1, required: true,
            prologueLen: 9,
            hypercallHandlerId: HANDLER_BFME_STRING_ASSIGN,
            entryFilter: buildBfmeStringAssignFilter,
        },
        small_pool_alloc: {
            name: 'small_pool_alloc',
            entryProbe: {
                kind: 'prologue', pattern: SMALL_POOL_ALLOC_PATTERN,
                mask: 'x'.repeat(SMALL_POOL_ALLOC_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 1, required: true,
            // push ebp; mov ebp,esp; push -1; push SEH-handler
            prologueLen: 10,
            entryFilter: buildBfmeSmallPoolAllocInline,
        },
        small_pool_free: {
            name: 'small_pool_free',
            entryProbe: {
                kind: 'prologue', pattern: SMALL_POOL_FREE_PATTERN,
                mask: 'x'.repeat(SMALL_POOL_FREE_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 2, required: true,
            // push ebp; mov ebp,esp; sub esp,0xc
            prologueLen: 6,
            entryFilter: buildBfmeSmallPoolFreeInline,
        },
        matrix_push: {
            name: 'matrix_push',
            entryProbe: {
                kind: 'prologue', pattern: MATRIX_PUSH_PATTERN,
                mask: 'x'.repeat(MATRIX_PUSH_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 0, required: true,
            hypercallHandlerId: HANDLER_BFME_MATRIX_PUSH,
        },
        matrix_pop: {
            name: 'matrix_pop',
            entryProbe: {
                kind: 'prologue', pattern: MATRIX_POP_PATTERN,
                mask: 'x'.repeat(MATRIX_POP_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 0, required: true,
            hypercallHandlerId: HANDLER_BFME_MATRIX_POP,
        },
        matrix_multiply: {
            name: 'matrix_multiply',
            entryProbe: {
                kind: 'prologue', pattern: MATRIX_MULTIPLY_PATTERN,
                mask: 'x'.repeat(MATRIX_MULTIPLY_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 3, required: true,
            hypercallHandlerId: HANDLER_BFME_MATRIX_MULTIPLY,
        },
        transform_push: {
            name: 'transform_push',
            entryProbe: {
                kind: 'prologue', pattern: TRANSFORM_PUSH_PATTERN,
                mask: 'x'.repeat(TRANSFORM_PUSH_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 0, required: true,
            hypercallHandlerId: HANDLER_BFME_TRANSFORM_PUSH,
        },
        transform_pop: {
            name: 'transform_pop',
            entryProbe: {
                kind: 'prologue', pattern: TRANSFORM_POP_PATTERN,
                mask: 'x'.repeat(TRANSFORM_POP_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 0, required: true,
            prologueLen: 6,
            hypercallHandlerId: HANDLER_BFME_TRANSFORM_POP,
            entryFilter: buildTransformPopWrapper,
        },
        matrix_adjust: {
            name: 'matrix_adjust',
            entryProbe: {
                kind: 'prologue', pattern: MATRIX_ADJUST_PATTERN,
                mask: 'x'.repeat(MATRIX_ADJUST_PATTERN.length), section: '.text',
            },
            // The wrapper copies the sole original argument for a cdecl stub,
            // retains the update callback, then performs the original RET 4.
            callingConvention: 'cdecl', argCount: 1, required: true,
            prologueLen: 6,
            hypercallHandlerId: HANDLER_BFME_MATRIX_ADJUST,
            entryFilter: buildMatrixAdjustWrapper,
        },
        tree_successor: {
            name: 'tree_successor',
            entryProbe: {
                kind: 'prologue', pattern: TREE_SUCCESSOR_PATTERN,
                mask: 'x'.repeat(TREE_SUCCESSOR_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 1, required: true,
            hypercallHandlerId: HANDLER_BFME_TREE_SUCCESSOR,
        },
        vertex_blend: {
            name: 'vertex_blend',
            entryProbe: {
                kind: 'prologue', pattern: VERTEX_BLEND_PATTERN,
                mask: 'x'.repeat(VERTEX_BLEND_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 0, required: true,
            // mov eax,[ebp-0x10]; fld dword [0x01083b6c]
            prologueLen: 9,
            hypercallHandlerId: HANDLER_BFME_VERTEX_BLEND,
            entryFilter: buildBfmeVertexBlendWrapper,
        },
        jpeg_idct_islow: {
            name: 'jpeg_idct_islow',
            entryProbe: {
                kind: 'prologue', pattern: JPEG_IDCT_ISLOW_PATTERN,
                mask: 'x'.repeat(JPEG_IDCT_ISLOW_PATTERN.length), section: '.text',
            },
            callingConvention: 'stdcall', argCount: 5, required: true,
            prologueLen: 6,
            hypercallHandlerId: HANDLER_BFME_JPEG_IDCT_ISLOW,
            shadow: bfmeJpegIdctShadow,
        },
        vector_ctor_iter: {
            name: 'vector_ctor_iter',
            entryProbe: {
                kind: 'prologue', pattern: VECTOR_CTOR_ITER_PATTERN,
                mask: 'x'.repeat(VECTOR_CTOR_ITER_PATTERN.length), section: '.text',
            },
            callingConvention: 'stdcall', argCount: 4, required: true,
            prologueLen: 5,
            entryFilter: buildBfmeVectorCtorFilter,
        },
        pixel_alpha_blend: {
            name: 'pixel_alpha_blend',
            entryProbe: {
                kind: 'prologue', pattern: PIXEL_ALPHA_BLEND_PATTERN,
                mask: 'x'.repeat(PIXEL_ALPHA_BLEND_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 4, required: true,
            // push ebp; mov ebp,esp; push ecx; push ebx; push esi
            prologueLen: 6,
            hypercallHandlerId: HANDLER_BFME_PIXEL_ALPHA_BLEND,
            shadow: bfmePixelAlphaBlendShadow,
        },
    },
    handlers: {
        string_lower: bfmeStringLowerHandler,
        string_release: bfmeStringReleaseHandler,
        string_copy: bfmeStringCopyHandler,
        string_assign: bfmeStringAssignHandler,
        small_pool_alloc: bfmeSmallPoolUnreachableHandler,
        small_pool_free: bfmeSmallPoolUnreachableHandler,
        matrix_push: bfmeMatrixPushHandler,
        matrix_pop: bfmeMatrixPopHandler,
        matrix_multiply: bfmeMatrixMultiplyHandler,
        transform_push: bfmeTransformPushHandler,
        transform_pop: bfmeTransformPopHandler,
        matrix_adjust: bfmeMatrixAdjustHandler,
        tree_successor: bfmeTreeSuccessorHandler,
        vertex_blend: bfmeVertexBlendFallbackHandler,
        vector_ctor_iter: bfmeVectorCtorUnreachableHandler,
    },
};
