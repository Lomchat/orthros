import type { LibDescriptor } from '../../types';
import {
    HANDLER_BFME_FOLD33_HASH,
    HANDLER_BFME_STRING_ASSIGN,
    HANDLER_BFME_STRING_COPY,
    HANDLER_BFME_STRING_LOWER,
    HANDLER_BFME_STRING_RELEASE,
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
    },
    handlers: {
        string_lower: bfmeStringLowerHandler,
        string_release: bfmeStringReleaseHandler,
        string_copy: bfmeStringCopyHandler,
        string_assign: bfmeStringAssignHandler,
    },
};
