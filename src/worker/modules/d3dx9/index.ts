/**
 * D3DX9 HLE — single implementation for all versioned d3dx9_XX.dll names.
 */

import { IModule } from '../../core/module';
import { Process } from '../../core/process';
import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';
import { d3dx9Module } from '../../api/d3dx9.api';
import { createMathExports } from './math';
import { createSurfaceExports } from './surfaces';
import { createTextureExports } from './textures';
import { createEffectExports, resetEffectState } from './effects';
import { computeFvfStride } from '../../backends/webgpu/ddraw/compute/vertex-converter';
import { Marshaler } from '../../core/memory/marshaler';
import { Mem } from '../../core/memory/mem-accessor';
import { assembleShader, ShaderAssemblyError } from './shader-assembler';
import { createD3dxBuffer, resetD3dxBuffers } from './buffer';

const D3DXERR_INVALIDDATA = 0x88760b59;

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;

const warnedStubs = new Set<string>();
const assembleShaderSamples: string[] = [];

export function getD3dxAssembleShaderSamples(): readonly string[] {
    return assembleShaderSamples;
}

function warnOnce(name: string, detail: string): void {
    if (warnedStubs.has(name)) return;
    warnedStubs.add(name);
    Logger.warn(LogCategory.SYSTEM, `d3dx9:${name} stub — ${detail}`);
}

function invalidCall(name: string): number {
    warnOnce(name, 'returning D3DERR_INVALIDCALL');
    return D3DERR_INVALIDCALL;
}

export class D3dx9 implements IModule {
    name = 'd3dx9';
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        const debugMute = () => 0;
        this.exports['DebugSetMute'] = debugMute;
        this.exports['D3DXDebugMute'] = debugMute;
        this.exports['D3DXCheckVersion'] = () => 1;
        this.exports['D3DXGetFVFVertexSize'] = (_ctx, _mem, args) => {
            try {
                return computeFvfStride(args[0] >>> 0) >>> 0;
            } catch {
                return 0;
            }
        };
        // HRESULT D3DXAssembleShader(LPCSTR pSrcData, UINT SrcDataLen, const D3DXMACRO*, LPD3DXINCLUDE,
        //                            DWORD Flags, LPD3DXBUFFER* ppShader, LPD3DXBUFFER* ppErrorMsgs)
        // SM1.x–3.0 text to bytecode; the byte buffer comes back as an ID3DXBuffer,
        // errors as a NUL-terminated message in ppErrorMsgs with D3DXERR_INVALIDDATA.
        this.exports['D3DXAssembleShader'] = (_ctx, mem, args) => {
            const sourcePtr = args[0] >>> 0;
            const sourceLength = args[1] >>> 0;
            const ppShader = args[5] >>> 0;
            const ppErrorMsgs = args[6] >>> 0;
            if (!sourcePtr || sourcePtr + sourceLength > mem.length) return D3DERR_INVALIDCALL;
            const source = sourceLength
                ? new TextDecoder('latin1').decode(mem.subarray(sourcePtr, sourcePtr + sourceLength))
                : Marshaler.readString(mem, sourcePtr);
            if (assembleShaderSamples.length < 16 && !assembleShaderSamples.includes(source)) assembleShaderSamples.push(source);
            if (ppErrorMsgs && ppErrorMsgs + 4 <= mem.length) Mem.writeUint32(ppErrorMsgs, 0);
            let tokens: Uint32Array;
            try {
                tokens = assembleShader(source);
            } catch (e) {
                const message = e instanceof ShaderAssemblyError ? e.message : `assembler: ${String(e)}`;
                Logger.warn(LogCategory.SYSTEM, `d3dx9:D3DXAssembleShader failed — ${message}`);
                if (ppShader && ppShader + 4 <= mem.length) Mem.writeUint32(ppShader, 0);
                if (ppErrorMsgs && ppErrorMsgs + 4 <= mem.length) {
                    const errBuf = createD3dxBuffer(process, new TextEncoder().encode(message + '\0'));
                    Mem.writeUint32(ppErrorMsgs, errBuf);
                }
                return D3DXERR_INVALIDDATA;
            }
            if (!ppShader || ppShader + 4 > mem.length) return D3DERR_INVALIDCALL;
            const bytes = new Uint8Array(tokens.buffer, tokens.byteOffset, tokens.byteLength);
            const buf = createD3dxBuffer(process, bytes);
            if (!buf) return D3DERR_INVALIDCALL;
            Mem.writeUint32(ppShader, buf);
            return D3D_OK;
        };

        Object.assign(this.exports, createMathExports());
        Object.assign(this.exports, createSurfaceExports());
        Object.assign(this.exports, createTextureExports());
        Object.assign(this.exports, createEffectExports(process));

        this.exports['D3DXTessellateNPatches'] = () => D3DERR_INVALIDCALL;
        this.exports['D3DXSavePRTCompBufferToFileW'] = () => D3DERR_INVALIDCALL;

        const fontSpriteStubs = [
            'D3DXCreateFontA',
            'D3DXCreateFontW',
            'D3DXCreateFontIndirectA',
            'D3DXCreateFontIndirectW',
            'D3DXCreateSprite',
        ];
        for (const name of fontSpriteStubs) {
            this.exports[name] = () => invalidCall(name);
        }

        for (const func of d3dx9Module.functions) {
            if (!this.exports[func.name]) {
                this.exports[func.name] = () => invalidCall(func.name);
            }
        }
    }

    reset(): void {
        warnedStubs.clear();
        assembleShaderSamples.length = 0;
        resetEffectState();
        resetD3dxBuffers();
    }
}
