import { describe, expect, test } from 'bun:test';
import { registerFastPathFileIoFindFunctions } from '../../src/worker/modules/kernel32/file-io-find';
import { System } from '../../src/worker/core/system';

describe('FindNextFile direct synchronous path', () => {
    test('advances a find handle and writes WIN32_FIND_DATAW without slow dispatch', () => {
        const fast = new Map<string, Function>();
        registerFastPathFileIoFindFunctions({
            registerFastPath: (_dll: string, name: string, fn: Function) => fast.set(name, fn),
        });
        expect([...fast.keys()]).toEqual(['FindNextFileA', 'FindNextFileW', 'FindClose']);

        const system = System.getInstance();
        const handle = system.resourceProvider.registerKernelObject({
            kind: 'find',
            index: 0,
            entries: [{
                path: 'C:\\Data\\Maps.big', name: 'Maps.big', kind: 'file',
                size: 0x1234, source: 'rom',
            }],
        });
        const memory = new Uint8Array(0x1000);
        const view = new DataView(memory.buffer);
        const esp = 0x100;
        const output = 0x200;
        view.setUint32(esp + 4, handle, true);
        view.setUint32(esp + 8, output, true);
        const cpu = { reg32: new Int32Array(8) };
        cpu.reg32[4] = esp;

        expect(fast.get('FindNextFileW')!(cpu, memory, new Uint32Array(memory.buffer), view)).toBe(1);
        expect(view.getUint32(output + 32, true)).toBe(0x1234);
        const name = String.fromCharCode(...Array.from({ length: 8 }, (_, i) => view.getUint16(output + 44 + i * 2, true)));
        expect(name).toBe('Maps.big');
        expect(fast.get('FindNextFileW')!(cpu, memory, new Uint32Array(memory.buffer), view)).toBe(0);
        expect(fast.get('FindClose')!(cpu, memory, new Uint32Array(memory.buffer), view)).toBe(1);
    });
});
