import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Mem } from "../../core/memory/mem-accessor";
import { OpenGLContext, GLDrawVertex } from "./context";
import { emitDrawCommand, pushVertexObj, bitsToF32 } from "./immediate";
import {
    GL_VERTEX_ARRAY, GL_NORMAL_ARRAY, GL_COLOR_ARRAY, GL_TEXTURE_COORD_ARRAY,
    GL_FLOAT, GL_DOUBLE, GL_INT, GL_SHORT, GL_UNSIGNED_BYTE, GL_UNSIGNED_SHORT,
    GL_UNSIGNED_INT, GL_BYTE,
} from "./constants";

function readArrayElement(
    mem: Uint8Array, byteOffset: number,
    pointer: number, index: number, size: number, type: number, stride: number
): number[] {
    const view = new DataView(mem.buffer, byteOffset);
    let elemSize = 0;
    switch (type) {
        case GL_FLOAT: elemSize = 4; break;
        case GL_DOUBLE: elemSize = 8; break;
        case GL_INT: case GL_UNSIGNED_INT: elemSize = 4; break;
        case GL_SHORT: case GL_UNSIGNED_SHORT: elemSize = 2; break;
        case GL_BYTE: case GL_UNSIGNED_BYTE: elemSize = 1; break;
        default: elemSize = 4; break;
    }
    const effectiveStride = stride > 0 ? stride : size * elemSize;
    const base = pointer + index * effectiveStride;
    const out: number[] = [];

    for (let j = 0; j < size; j++) {
        const addr = base + j * elemSize;
        switch (type) {
            case GL_FLOAT: out.push(view.getFloat32(addr, true)); break;
            case GL_DOUBLE: out.push(view.getFloat64(addr, true)); break;
            case GL_INT: out.push(view.getInt32(addr, true)); break;
            case GL_UNSIGNED_INT: out.push(view.getUint32(addr, true)); break;
            case GL_SHORT: out.push(view.getInt16(addr, true)); break;
            case GL_UNSIGNED_SHORT: out.push(view.getUint16(addr, true)); break;
            case GL_BYTE: out.push(view.getInt8(addr)); break;
            case GL_UNSIGNED_BYTE: out.push(view.getUint8(addr)); break;
            default: out.push(0); break;
        }
    }
    return out;
}

function readVertexFromArrays(ctx: OpenGLContext, index: number): GLDrawVertex {
    const mem = ctx.process.getCurrentMemory();
    const byteOffset = mem.byteOffset;
    const v: GLDrawVertex = {
        x: 0, y: 0, z: 0, w: 1,
        r: ctx.currentColor[0], g: ctx.currentColor[1],
        b: ctx.currentColor[2], a: ctx.currentColor[3],
        nx: ctx.currentNormal[0], ny: ctx.currentNormal[1], nz: ctx.currentNormal[2],
        s0: 0, t0: 0, s1: 0, t1: 0,
    };

    if (ctx.vertexArray.enabled && ctx.vertexArray.pointer) {
        const d = readArrayElement(mem, byteOffset, ctx.vertexArray.pointer, index,
            ctx.vertexArray.size, ctx.vertexArray.type, ctx.vertexArray.stride);
        v.x = d[0] ?? 0;
        v.y = d[1] ?? 0;
        if (ctx.vertexArray.size >= 3) v.z = d[2] ?? 0;
        if (ctx.vertexArray.size >= 4) v.w = d[3] ?? 1;
    }

    if (ctx.colorArray.enabled && ctx.colorArray.pointer) {
        const d = readArrayElement(mem, byteOffset, ctx.colorArray.pointer, index,
            ctx.colorArray.size, ctx.colorArray.type, ctx.colorArray.stride);
        if (ctx.colorArray.type === GL_UNSIGNED_BYTE) {
            v.r = (d[0] ?? 255) / 255;
            v.g = (d[1] ?? 255) / 255;
            v.b = (d[2] ?? 255) / 255;
            v.a = ctx.colorArray.size >= 4 ? (d[3] ?? 255) / 255 : 1;
        } else {
            v.r = d[0] ?? 1; v.g = d[1] ?? 1; v.b = d[2] ?? 1;
            v.a = ctx.colorArray.size >= 4 ? (d[3] ?? 1) : 1;
        }
    }

    if (ctx.normalArray.enabled && ctx.normalArray.pointer) {
        const d = readArrayElement(mem, byteOffset, ctx.normalArray.pointer, index,
            3, ctx.normalArray.type, ctx.normalArray.stride);
        v.nx = d[0] ?? 0; v.ny = d[1] ?? 0; v.nz = d[2] ?? 1;
    }

    // Texture coord unit 0
    if (ctx.texCoordArrays[0].enabled && ctx.texCoordArrays[0].pointer) {
        const tc = ctx.texCoordArrays[0];
        const d = readArrayElement(mem, byteOffset, tc.pointer, index, tc.size, tc.type, tc.stride);
        v.s0 = d[0] ?? 0; v.t0 = d[1] ?? 0;
    }

    // Texture coord unit 1
    if (ctx.texCoordArrays[1].enabled && ctx.texCoordArrays[1].pointer) {
        const tc = ctx.texCoordArrays[1];
        const d = readArrayElement(mem, byteOffset, tc.pointer, index, tc.size, tc.type, tc.stride);
        v.s1 = d[0] ?? 0; v.t1 = d[1] ?? 0;
    }

    return v;
}

export function createArrayExports(ctx: OpenGLContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['glVertexPointer'] = (_c, _m, args): number => {
        ctx.vertexArray.size = args[0] | 0;
        ctx.vertexArray.type = args[1] >>> 0;
        ctx.vertexArray.stride = args[2] | 0;
        ctx.vertexArray.pointer = args[3] >>> 0;
        return 0;
    };

    exports['glNormalPointer'] = (_c, _m, args): number => {
        ctx.normalArray.type = args[0] >>> 0;
        ctx.normalArray.stride = args[1] | 0;
        ctx.normalArray.pointer = args[2] >>> 0;
        ctx.normalArray.size = 3;
        return 0;
    };

    exports['glColorPointer'] = (_c, _m, args): number => {
        ctx.colorArray.size = args[0] | 0;
        ctx.colorArray.type = args[1] >>> 0;
        ctx.colorArray.stride = args[2] | 0;
        ctx.colorArray.pointer = args[3] >>> 0;
        return 0;
    };

    exports['glTexCoordPointer'] = (_c, _m, args): number => {
        const unit = ctx.clientActiveTextureUnit;
        if (unit < ctx.texCoordArrays.length) {
            ctx.texCoordArrays[unit].size = args[0] | 0;
            ctx.texCoordArrays[unit].type = args[1] >>> 0;
            ctx.texCoordArrays[unit].stride = args[2] | 0;
            ctx.texCoordArrays[unit].pointer = args[3] >>> 0;
        }
        return 0;
    };

    exports['glEnableClientState'] = (_c, _m, args): number => {
        const cap = args[0] >>> 0;
        switch (cap) {
            case GL_VERTEX_ARRAY: ctx.vertexArray.enabled = true; break;
            case GL_NORMAL_ARRAY: ctx.normalArray.enabled = true; break;
            case GL_COLOR_ARRAY: ctx.colorArray.enabled = true; break;
            case GL_TEXTURE_COORD_ARRAY:
                if (ctx.clientActiveTextureUnit < ctx.texCoordArrays.length)
                    ctx.texCoordArrays[ctx.clientActiveTextureUnit].enabled = true;
                break;
        }
        return 0;
    };

    exports['glDisableClientState'] = (_c, _m, args): number => {
        const cap = args[0] >>> 0;
        switch (cap) {
            case GL_VERTEX_ARRAY: ctx.vertexArray.enabled = false; break;
            case GL_NORMAL_ARRAY: ctx.normalArray.enabled = false; break;
            case GL_COLOR_ARRAY: ctx.colorArray.enabled = false; break;
            case GL_TEXTURE_COORD_ARRAY:
                if (ctx.clientActiveTextureUnit < ctx.texCoordArrays.length)
                    ctx.texCoordArrays[ctx.clientActiveTextureUnit].enabled = false;
                break;
        }
        return 0;
    };

    exports['glArrayElement'] = (_c, _m, args): number => {
        const index = args[0] | 0;
        const v = readVertexFromArrays(ctx, index);
        pushVertexObj(ctx, v);
        return 0;
    };

    exports['glDrawArrays'] = (_c, _m, args): number => {
        const mode = args[0] >>> 0;
        const first = args[1] | 0;
        const count = args[2] | 0;
        if (count <= 0) return 0;

        const verts: GLDrawVertex[] = [];
        for (let j = 0; j < count; j++) {
            verts.push(readVertexFromArrays(ctx, first + j));
        }
        emitDrawCommand(ctx, mode, verts);
        return 0;
    };

    exports['glDrawElements'] = (_c, _m, args): number => {
        const mode = args[0] >>> 0;
        const count = args[1] | 0;
        const type = args[2] >>> 0;
        const indicesPtr = args[3] >>> 0;
        if (count <= 0 || !indicesPtr) return 0;

        const mem = ctx.process.getCurrentMemory();
        const view = new DataView(mem.buffer, mem.byteOffset);
        const verts: GLDrawVertex[] = [];

        for (let j = 0; j < count; j++) {
            let index = 0;
            switch (type) {
                case GL_UNSIGNED_BYTE: index = mem[mem.byteOffset + indicesPtr + j]; break;
                case GL_UNSIGNED_SHORT: index = view.getUint16(indicesPtr + j * 2, true); break;
                case GL_UNSIGNED_INT: index = view.getUint32(indicesPtr + j * 4, true); break;
            }
            verts.push(readVertexFromArrays(ctx, index));
        }
        emitDrawCommand(ctx, mode, verts);
        return 0;
    };

    exports['glDrawRangeElements'] = (_c, _m, args) => {
        // Delegate to DrawElements (args[1]=start, args[2]=end are hints only)
        const newArgs = [args[0], args[3], args[4], args[5]];
        return exports['glDrawElements']!(_c, _m, newArgs as any);
    };

    exports['glInterleavedArrays'] = (): number => 0;
    exports['glEdgeFlagPointer'] = (): number => 0;
    exports['glIndexPointer'] = (): number => 0;

    exports['glLockArraysEXT'] = (): number => 0;
    exports['glUnlockArraysEXT'] = (): number => 0;

    return exports;
}
