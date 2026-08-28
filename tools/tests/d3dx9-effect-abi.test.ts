import { describe, expect, test } from 'bun:test';
import { ID3DX_EFFECT_METHOD_SPECS } from '../../src/worker/modules/d3dx9/effects';

describe('ID3DXEffect SDK 27 ABI', () => {
    test('keeps the exact base/effect vtable order and cleanup arities', () => {
        expect(ID3DX_EFFECT_METHOD_SPECS.length).toBe(76);
        expect(ID3DX_EFFECT_METHOD_SPECS.slice(0, 17)).toEqual([
            ['GetDesc', 2], ['GetParameterDesc', 3], ['GetTechniqueDesc', 3], ['GetPassDesc', 3],
            ['GetFunctionDesc', 3], ['GetParameter', 3], ['GetParameterByName', 3],
            ['GetParameterBySemantic', 3], ['GetParameterElement', 3], ['GetTechnique', 2],
            ['GetTechniqueByName', 2], ['GetPass', 3], ['GetPassByName', 3], ['GetFunction', 2],
            ['GetFunctionByName', 2], ['GetAnnotation', 3], ['GetAnnotationByName', 3],
        ]);
        expect(ID3DX_EFFECT_METHOD_SPECS.slice(-6)).toEqual([
            ['BeginParameterBlock', 1], ['EndParameterBlock', 1], ['ApplyParameterBlock', 2],
            ['DeleteParameterBlock', 2], ['CloneEffect', 3], ['SetRawValue', 5],
        ]);
        expect(ID3DX_EFFECT_METHOD_SPECS.find(([name]) => name === 'GetCurrentTechnique')?.[1]).toBe(1);
        expect(ID3DX_EFFECT_METHOD_SPECS.find(([name]) => name === 'GetPassDesc')?.[1]).toBe(3);
    });
});
