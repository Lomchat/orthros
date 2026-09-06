import type { LibDescriptor } from '../../types';
import {
    HANDLER_MSVCR71_SSCANF_SCALAR,
    HANDLER_MSVCR71_STRICMP,
    HANDLER_MSVCR71_MEMCMP,
    HANDLER_MSVCR71_STRLEN,
    HANDLER_MSVCR71_STRNCPY,
    HANDLER_MSVCR71_STRNICMP,
    HANDLER_MSVCR71_STRCMP,
    HANDLER_STRSTR,
    HANDLER_CDECL_CEIL,
} from '../../../cpu/hypercall-data';
import {
    buildMsvcr71AddCarryInline,
    buildMsvcr71Add96Inline,
    buildMsvcr71Shift96Inline,
    msvcr71ArithmeticUnreachableHandler,
} from './arithmetic-inline';
import { msvcr71StricmpShadow } from './string-compare';
import {
    msvcr71MemcmpShadow,
    msvcr71StrlenShadow,
    msvcr71StrncpyShadow,
    msvcr71StrnicmpShadow,
    msvcr71StrcmpShadow,
    msvcr71StrstrShadow,
} from './string-memory';
import { buildMsvcr71SscanfScalarFilter, msvcr71SscanfScalarFallback } from './scanf-scalar';
import { msvcr71VsnprintfFallback, msvcr71VsnprintfShadow } from './vsnprintf';
import { buildMsvcr71GetPtdInline } from './getptd-inline';
import { buildMsvcr71LocaleStricmpFilter } from './locale-compare-inline';
import {
    buildMsvcr71FiniteDoubleFilter,
    buildMsvcr71FloorInline,
    msvcr71CeilFallback,
    msvcr71FloorFallback,
} from './rounding-filter';

function hexBytes(hex: string): Uint8Array {
    const compact = hex.replace(/\s+/g, '');
    const out = new Uint8Array(compact.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
    return out;
}

// MSVCR71.dll 7.10.3052.4, RVA 0x32f35. This internal leaf adds two 32-bit
// limbs, stores the result and returns the unsigned carry. BFME's floating-
// point formatting path called it roughly 220K times in 2.5 seconds.
const ADD_CARRY_PATTERN = hexBytes(
    '8b542404 56 8b74240c 8d0c32 33c0 3bca 7204 3bce 7303 ' +
    '33c0 40 8b542410 890a 5e c3',
);

// Adjacent internal leaf at RVA 0x32f56. It adds two little-endian 96-bit
// integers in place by calling the 32-bit carry helper three times.
const ADD96_PATTERN = hexBytes(
    '56 8b742408 57 8b7c2410 56 ff37 ff36 e8cbffffff 83c40c 85c0 7417 ' +
    '8d4604 50 6a01 ff30 e8b7ffffff 83c40c 85c0 7403 ff4608 ' +
    '8d4604 50 ff7704 ff30 e89fffffff 83c40c 85c0 7403 ff4608 ' +
    '8d4608 50 ff7708 ff30 e887ffffff 83c40c 5f 5e c3',
);

// Adjacent internal leaf at RVA 0x32fb4. It shifts a three-dword integer left
// by one during decimal conversion and was called roughly 112K times in the
// same transition window.
const SHIFT96_PATTERN = hexBytes(
    '8b442404 56 8b30 8bce 03f6 57 8b7804 c1e91f 8930 ' +
    '8d343f 0bf1 8b4808 8bd7 c1ea1f d1e1 0bca 5f ' +
    '897004 894808 5e c3',
);

// MSVCR71.dll 7.10.3052.4, RVA 0x32ec. This is the complete byte-exact
// `_stricmp` body, including its ASCII-only folding behavior.
const STRICMP_PATTERN = hexBytes(
    '558bec5756538b750c8b7d08b0ff8bff0ac074328a0683c6018a2783c701' +
    '3ae074ee2c413c1a1ac980e12002c1044186e02c413c1a1ac980e12002c1' +
    '04413ac474ce1ac01cff0fbec05b5e5fc9c3',
);

// Exported `sscanf`, RVA 0x2c224. The entry filter admits only the exact
// one-output formats `%d`, `%u` and `%f`; every complex format stays native.
const SSCANF_PATTERN = hexBytes(
    '558bec83ec20 8b4508 50 c745ec49000000 8945e8 8945e0 ' +
    'e89555fdff 8945e4 8d4510 50 ff750c 8d45e0 50 e840120000 ' +
    '83c410 c9 c3',
);

// Exported `_vsnprintf`, RVA 0x2a9bb. This complete byte-exact body is shared
// by the VC71 runtime bundled with BFME 1, BFME II and Roi-Sorcier.
const VSNPRINTF_PATTERN = hexBytes(
    '558bec83ec20 8b450c 56 8b7508 57 ff7514 8945e4 ff7510 8d45e0 50 ' +
    'c745ec42000000 8975e8 8975e0 e8ca4ffeff 83c40c 85f6 8bf8 741a ' +
    'ff4de4 7808 8b45e0 c60000 eb0d 8d45e0 50 6a00 e86b58feff 59 59 ' +
    '8bc7 5f 5e c9 c3',
);

// Exported `memcmp`, RVA 0x3234. The native implementation returns a
// normalized -1/0/+1 and its small-block dispatch dominates C++ string-key
// comparisons during SAGE data loading.
const MEMCMP_PATTERN = hexBytes(
    '8b44240c85c0744a8b54240456578bf28b7c24100bd783e2037438a90100000074' +
    '118a0e3a0f755883c60183c70183e801741d8a0e8a173aca75458a4e018a57',
);

// Exported `strlen`, RVA 0x17d5. Match through the aligned dword loop so the
// hook cannot attach to a short compiler-generated lookalike.
const STRLEN_PATTERN = hexBytes(
    '8b4c2404f7c103000000741a8a0183c10184c074e1f7c10300000075ef83c000' +
    '8d24248d24248b01bafffefe7e03d083f0ff33c283c104a90001018174e88b41',
);

const STRNCPY_PATTERN = hexBytes(
    '8b4c240c5785c90f849200000056538bd98b742414f7c6030000008b7c2410750b' +
    'c1e9020f8585000000eb278a0683c601880783c70183e901742b84c0742ff7',
);

// Locale-independent ASCII body used by the exported `_strnicmp` wrapper in
// the C locale. Hooking this internal leaf preserves the wrapper's locale gate.
const STRNICMP_PATTERN = hexBytes(
    '558bec5756538b4d100bc974448b75088b7d0cb741b35ab6208d098a2683c6018a' +
    '0783c7013ae074183ae772063ae3770202e63ac772063ac3770202c63ae075',
);

// Exported `strcmp`, RVA 0x2cc0. This VC71 build normalizes ordering to
// -1/+1, unlike the raw byte difference permitted by the C standard.
const STRCMP_PATTERN = hexBytes(
    '8b5424048b4c2408f7c203000000753b8b023a01752d0ac074263a610175240ae4' +
    '741dc1e8103a410275180ac074113a6103750f83c10483c2040ae475d28bff33c0',
);

// Exported `strstr`, RVA 0x28cf. Its optimized two-byte search accounted for
// most of the remaining VC71 page after memcmp/strlen were removed.
const STRSTR_PATTERN = hexBytes(
    '8b4c24085753568a118b7c241084d2746f8a710184f674558bf78b4c24148a0783' +
    'c6013ac2741784c0740d8a0683c6013ac2740a84c075f35e5b5f33c0c38a0683',
);

// Internal `_getptd`, RVA 0x9636. Absolute IAT/data operands are relocation
// sites and are deliberately wildcarded; the surrounding code is exact.
const GETPTD_PATTERN = hexBytes(
    '53 56 ff15 00000000 ff35 00000000 8bd8 ff15 00000000 ' +
    '8bf0 85f6 7549 688c000000 6a01',
);
const GETPTD_MASK = 'xxxx????xx????xxxx????xxxxxxxxxxxxx';

// Exported locale-aware `_stricmp`, RVA 0x105dc. Relative calls and the
// relocated global-locale operand are wildcarded; the C-locale gate is exact.
const LOCALE_STRICMP_PATTERN = hexBytes(
    '558bec5153 e800000000 8b5864 3b1d00000000 7407 e800000000 8bd8 ' +
    '837b1400 750f ff750c ff7508 e800000000 5959 eb35',
);
const LOCALE_STRICMP_MASK =
    'xxxxxx????' + 'xxxxx????' + 'xxx????' + 'xxxxxxxxxxxxxxx????xxxx';

// VC71's x87 fallbacks for exported ceil/floor. On v86 the runtime's SSE2
// capability flag is false, so the public entries jump here. Absolute globals
// are relocated and wildcarded; the distinct relative call identifies each
// routine within the byte-identical VC71 build used by the three BFME games.
const CEIL_X87_PATTERN = hexBytes(
    '558bec51515356beffff000056ff35 00000000 e8d1e9ffff dd4508',
);
const FLOOR_X87_PATTERN = hexBytes(
    '558bec51515356beffff000056ff35 00000000 e8fee8ffff dd4508',
);
const ROUND_X87_MASK = 'x'.repeat(15) + '????' + 'x'.repeat(8);


export const msvcr71Descriptor: LibDescriptor = {
    id: 'msvcr71',
    displayName: 'MSVCR71 7.10 arithmetic leaves',
    // Require both byte-exact adjacent helpers. A single short arithmetic
    // sequence is deliberately insufficient to identify this CRT build.
    minConfidence: 16,
    signatures: {
        add_carry: {
            kind: 'bytes', pattern: ADD_CARRY_PATTERN,
            mask: 'x'.repeat(ADD_CARRY_PATTERN.length), section: '.text', weight: 8,
        },
        add96: {
            kind: 'bytes', pattern: ADD96_PATTERN,
            mask: 'x'.repeat(ADD96_PATTERN.length), section: '.text', weight: 8,
        },
        shift96: {
            kind: 'bytes', pattern: SHIFT96_PATTERN,
            mask: 'x'.repeat(SHIFT96_PATTERN.length), section: '.text', weight: 8,
        },
        stricmp: {
            kind: 'bytes', pattern: STRICMP_PATTERN,
            mask: 'x'.repeat(STRICMP_PATTERN.length), section: '.text', weight: 8,
        },
        sscanf_scalar: {
            kind: 'bytes', pattern: SSCANF_PATTERN,
            mask: 'x'.repeat(SSCANF_PATTERN.length), section: '.text', weight: 8,
        },
        vsnprintf: {
            kind: 'bytes', pattern: VSNPRINTF_PATTERN,
            mask: 'x'.repeat(VSNPRINTF_PATTERN.length), section: '.text', weight: 8,
        },
        memcmp: {
            kind: 'bytes', pattern: MEMCMP_PATTERN,
            mask: 'x'.repeat(MEMCMP_PATTERN.length), section: '.text', weight: 8,
        },
        strlen: {
            kind: 'bytes', pattern: STRLEN_PATTERN,
            mask: 'x'.repeat(STRLEN_PATTERN.length), section: '.text', weight: 8,
        },
        strncpy: {
            kind: 'bytes', pattern: STRNCPY_PATTERN,
            mask: 'x'.repeat(STRNCPY_PATTERN.length), section: '.text', weight: 8,
        },
        strnicmp_ascii: {
            kind: 'bytes', pattern: STRNICMP_PATTERN,
            mask: 'x'.repeat(STRNICMP_PATTERN.length), section: '.text', weight: 8,
        },
        strcmp: {
            kind: 'bytes', pattern: STRCMP_PATTERN,
            mask: 'x'.repeat(STRCMP_PATTERN.length), section: '.text', weight: 8,
        },
        strstr: {
            kind: 'bytes', pattern: STRSTR_PATTERN,
            mask: 'x'.repeat(STRSTR_PATTERN.length), section: '.text', weight: 8,
        },
        getptd: {
            kind: 'bytes', pattern: GETPTD_PATTERN,
            mask: GETPTD_MASK, section: '.text', weight: 8,
        },
        stricmp_locale: {
            kind: 'bytes', pattern: LOCALE_STRICMP_PATTERN,
            mask: LOCALE_STRICMP_MASK, section: '.text', weight: 8,
        },
        ceil_x87: {
            kind: 'bytes', pattern: CEIL_X87_PATTERN,
            mask: ROUND_X87_MASK, section: '.text', weight: 8,
        },
        floor_x87: {
            kind: 'bytes', pattern: FLOOR_X87_PATTERN,
            mask: ROUND_X87_MASK, section: '.text', weight: 8,
        },
    },
    functions: {
        add_carry: {
            name: 'add_carry',
            entryProbe: {
                kind: 'prologue', pattern: ADD_CARRY_PATTERN,
                mask: 'x'.repeat(ADD_CARRY_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 3, required: true,
            // mov edx,[esp+4]; push esi
            prologueLen: 5,
            entryFilter: buildMsvcr71AddCarryInline,
        },
        add96: {
            name: 'add96',
            entryProbe: {
                kind: 'prologue', pattern: ADD96_PATTERN,
                mask: 'x'.repeat(ADD96_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 2, required: true,
            // push esi; mov esi,[esp+8]
            prologueLen: 5,
            entryFilter: buildMsvcr71Add96Inline,
        },
        shift96: {
            name: 'shift96',
            entryProbe: {
                kind: 'prologue', pattern: SHIFT96_PATTERN,
                mask: 'x'.repeat(SHIFT96_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 1, required: true,
            // mov eax,[esp+4]; push esi
            prologueLen: 5,
            entryFilter: buildMsvcr71Shift96Inline,
        },
        stricmp: {
            name: 'stricmp',
            entryProbe: {
                kind: 'prologue', pattern: STRICMP_PATTERN,
                mask: 'x'.repeat(STRICMP_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 2, required: true,
            // push ebp; mov ebp,esp; push edi; push esi
            prologueLen: 6,
            hypercallHandlerId: HANDLER_MSVCR71_STRICMP,
            shadow: msvcr71StricmpShadow,
        },
        sscanf_scalar: {
            name: 'sscanf_scalar',
            entryProbe: {
                kind: 'prologue', pattern: SSCANF_PATTERN,
                mask: 'x'.repeat(SSCANF_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 3, required: true,
            // push ebp; mov ebp,esp; sub esp,0x20
            prologueLen: 6,
            entryFilter: buildMsvcr71SscanfScalarFilter,
            hypercallHandlerId: HANDLER_MSVCR71_SSCANF_SCALAR,
        },
        vsnprintf: {
            name: 'vsnprintf',
            entryProbe: {
                kind: 'prologue', pattern: VSNPRINTF_PATTERN,
                mask: 'x'.repeat(VSNPRINTF_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 4, required: false,
            prologueLen: 6,
            shadow: msvcr71VsnprintfShadow,
        },
        memcmp: {
            name: 'memcmp',
            entryProbe: {
                kind: 'prologue', pattern: MEMCMP_PATTERN,
                mask: 'x'.repeat(MEMCMP_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 3, required: false,
            prologueLen: 6,
            hypercallHandlerId: HANDLER_MSVCR71_MEMCMP,
            shadow: msvcr71MemcmpShadow,
        },
        strlen: {
            name: 'strlen',
            entryProbe: {
                kind: 'prologue', pattern: STRLEN_PATTERN,
                mask: 'x'.repeat(STRLEN_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 1, required: false,
            prologueLen: 10,
            hypercallHandlerId: HANDLER_MSVCR71_STRLEN,
            shadow: msvcr71StrlenShadow,
        },
        strncpy: {
            name: 'strncpy',
            entryProbe: {
                kind: 'prologue', pattern: STRNCPY_PATTERN,
                mask: 'x'.repeat(STRNCPY_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 3, required: false,
            prologueLen: 5,
            hypercallHandlerId: HANDLER_MSVCR71_STRNCPY,
            shadow: msvcr71StrncpyShadow,
        },
        strnicmp_ascii: {
            name: 'strnicmp_ascii',
            entryProbe: {
                kind: 'prologue', pattern: STRNICMP_PATTERN,
                mask: 'x'.repeat(STRNICMP_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 3, required: false,
            prologueLen: 6,
            hypercallHandlerId: HANDLER_MSVCR71_STRNICMP,
            shadow: msvcr71StrnicmpShadow,
        },
        strcmp: {
            name: 'strcmp',
            entryProbe: {
                kind: 'prologue', pattern: STRCMP_PATTERN,
                mask: 'x'.repeat(STRCMP_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 2, required: false,
            prologueLen: 8,
            hypercallHandlerId: HANDLER_MSVCR71_STRCMP,
            shadow: msvcr71StrcmpShadow,
        },
        strstr: {
            name: 'strstr',
            entryProbe: {
                kind: 'prologue', pattern: STRSTR_PATTERN,
                mask: 'x'.repeat(STRSTR_PATTERN.length), section: '.text',
            },
            callingConvention: 'cdecl', argCount: 2, required: false,
            prologueLen: 6,
            hypercallHandlerId: HANDLER_STRSTR,
            shadow: msvcr71StrstrShadow,
        },
        getptd: {
            name: 'getptd',
            entryProbe: {
                kind: 'prologue', pattern: GETPTD_PATTERN,
                mask: GETPTD_MASK, section: '.text',
            },
            callingConvention: 'cdecl', argCount: 0, required: false,
            // push ebx; push esi; call dword ptr [GetLastError]
            prologueLen: 8,
            entryFilter: buildMsvcr71GetPtdInline,
        },
        stricmp_locale: {
            name: 'stricmp_locale',
            entryProbe: {
                kind: 'prologue', pattern: LOCALE_STRICMP_PATTERN,
                mask: LOCALE_STRICMP_MASK, section: '.text',
            },
            callingConvention: 'cdecl', argCount: 2, required: false,
            // push ebp; mov ebp,esp; push ecx
            prologueLen: 5,
            entryFilter: buildMsvcr71LocaleStricmpFilter,
            hypercallHandlerId: HANDLER_MSVCR71_STRICMP,
            shadow: msvcr71StricmpShadow,
        },
        ceil_x87: {
            name: 'ceil_x87',
            entryProbe: {
                kind: 'prologue', pattern: CEIL_X87_PATTERN,
                mask: ROUND_X87_MASK, section: '.text',
            },
            callingConvention: 'cdecl', argCount: 2, required: false,
            // push ebp; mov ebp,esp; push ecx; push ecx
            prologueLen: 6,
            entryFilter: buildMsvcr71FiniteDoubleFilter,
            hypercallHandlerId: HANDLER_CDECL_CEIL,
        },
        floor_x87: {
            name: 'floor_x87',
            entryProbe: {
                kind: 'prologue', pattern: FLOOR_X87_PATTERN,
                mask: ROUND_X87_MASK, section: '.text',
            },
            callingConvention: 'cdecl', argCount: 2, required: false,
            prologueLen: 6,
            entryFilter: buildMsvcr71FloorInline,
        },
    },
    handlers: {
        add_carry: msvcr71ArithmeticUnreachableHandler,
        add96: msvcr71ArithmeticUnreachableHandler,
        shift96: msvcr71ArithmeticUnreachableHandler,
        sscanf_scalar: msvcr71SscanfScalarFallback,
        vsnprintf: msvcr71VsnprintfFallback,
        getptd: msvcr71ArithmeticUnreachableHandler,
        ceil_x87: msvcr71CeilFallback,
        floor_x87: msvcr71FloorFallback,
    },
};
