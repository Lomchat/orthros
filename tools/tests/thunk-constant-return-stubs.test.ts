// A constant-return export gets the leaf `MOV EAX, value ; RET N` instead of the
// port-write stub, at both emission sites; other exports keep the trap.
import { describe, it, expect } from 'bun:test';
import { ThunkGenerator } from '../../src/worker/core/thunking/thunk-generator';

describe('constant-return stubs', () => {
    it('generateStubDll emits the leaf for a declared export and the trap for the others', () => {
        const gen = new ThunkGenerator();
        gen.declareConstantReturn('d3dx9', 'ID3DXEffect_CommitChanges', 0);
        const dll = gen.generateStubDll('d3dx9', [
            { name: 'ID3DXEffect_CommitChanges', argCount: 1 },
            { name: 'ID3DXEffect_SetTechnique', argCount: 2 },
        ]);
        const at = (name: string) => dll.exportTable.get(name.toLowerCase())! - dll.baseAddress;
        const leaf = at('ID3DXEffect_CommitChanges');
        expect(Array.from(dll.stubCode.subarray(leaf, leaf + 8))).toEqual([0xB8, 0, 0, 0, 0, 0xC2, 4, 0]);
        expect(dll.stubCode.subarray(leaf, leaf + 16).includes(0xEF)).toBe(false);
        const trap = at('ID3DXEffect_SetTechnique');
        expect(dll.stubCode[trap]).toBe(0xB8);
        expect(Array.from(dll.stubCode.subarray(trap + 5, trap + 11))).toEqual([0xBA, 0x77, 0xB0, 0, 0, 0xEF]);
        const stub = gen.getAllStubs().find((s) => s.functionName === 'ID3DXEffect_CommitChanges')!;
        expect(stub.constantReturn).toBe(0);
        expect(gen.getAllStubs().find((s) => s.functionName === 'ID3DXEffect_SetTechnique')!.constantReturn).toBeUndefined();
    });

    it('allocateOneStub honours the declaration with a non-zero value', () => {
        const gen = new ThunkGenerator();
        gen.declareConstantReturn('d3d9', 'IDirect3DDevice9_Probe', 0x8876086c);
        const one = gen.allocateOneStub('d3d9', 'IDirect3DDevice9_Probe', 1);
        expect(Array.from(one.code.subarray(0, 8))).toEqual([0xB8, 0x6c, 0x08, 0x76, 0x88, 0xC2, 4, 0]);
        expect(one.code.includes(0xEF)).toBe(false);
    });

    it('keeps the trap when nothing is declared', () => {
        const gen = new ThunkGenerator();
        const one = gen.allocateOneStub('kernel32', 'Sleep', 1);
        expect(Array.from(one.code.subarray(5, 11))).toEqual([0xBA, 0x77, 0xB0, 0, 0, 0xEF]);
    });
});
