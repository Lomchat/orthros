import { describe, expect, test } from 'bun:test';
import { shouldInstallHook } from '../../src/worker/core/hle-lib/hook-policy';
import type { HookedFunction } from '../../src/worker/core/hle-lib/types';

function declaration(enabledByDefault?: boolean): HookedFunction {
    return {
        name: 'hot_loop',
        entryProbe: { kind: 'prologue', pattern: new Uint8Array([0x90]), mask: 'x' },
        callingConvention: 'cdecl',
        argCount: 0,
        required: false,
        enabledByDefault,
    };
}

describe('HLE hook installation policy', () => {
    test('keeps established hooks enabled by default', () => {
        expect(shouldInstallHook(declaration(), 'hot_loop', new Set(), new Set())).toBe(true);
    });

    test('gives inactive experiments a zero-cost unpatched default', () => {
        expect(shouldInstallHook(declaration(false), 'hot_loop', new Set(), new Set())).toBe(false);
    });

    test('allows an explicit experiment opt-in', () => {
        expect(shouldInstallHook(declaration(false), 'hot_loop', new Set(), new Set(['hot_loop']))).toBe(true);
    });

    test('explicit opt-out wins over opt-in', () => {
        expect(shouldInstallHook(
            declaration(false), 'hot_loop', new Set(['hot_loop']), new Set(['hot_loop']),
        )).toBe(false);
    });
});
