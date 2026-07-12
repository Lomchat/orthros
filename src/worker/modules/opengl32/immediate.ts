import { ThunkImplementation, WriteBufHandler } from "../../core/thunking/thunk-dispatcher";
import {
    OpenGLContext, GLDrawVertex, GLDrawCommand, GLDrawCommandType, mat4Multiply, VERT_FLOATS
} from "./context";
import {
    GL_TRIANGLES, GL_TRIANGLE_STRIP, GL_TRIANGLE_FAN, GL_QUADS, GL_QUAD_STRIP,
    GL_POLYGON, GL_POINTS, GL_LINES, GL_LINE_STRIP, GL_LINE_LOOP,
    GL_INVALID_OPERATION,
    GL_TEXTURE_GEN_S, GL_TEXTURE_GEN_T,
    GL_OBJECT_LINEAR, GL_EYE_LINEAR, GL_SPHERE_MAP, GL_STENCIL_TEST,
} from "./constants";
import { Logger, LogCategory } from "../../core/logger";
import { asArrayBuffer } from "../../../dom-buffer";

const _f32ab = new ArrayBuffer(4);
const _f32dv = new DataView(_f32ab);
export function bitsToF32(bits: number): number {
    _f32dv.setUint32(0, bits >>> 0, true);
    return _f32dv.getFloat32(0, true);
}

// Module-level scratch buffers — zero allocations on hot paths
const _mvpScratch = new Float32Array(16);
const _asmBuf = new Float32Array(131072 * VERT_FLOATS); // 128K vertices max

// Cached DataView for guest memory — recreate only when buffer changes
let _cachedDVBuf: ArrayBuffer | null = null;
let _cachedDV: DataView | null = null;

function getMemDV(ctx: OpenGLContext): DataView {
    const mem = ctx.process.getCurrentMemory();
    if (mem.buffer !== _cachedDVBuf) {
        _cachedDVBuf = asArrayBuffer(mem.buffer);
        _cachedDV = new DataView(mem.buffer, mem.byteOffset);
    }
    return _cachedDV!;
}

// Helper to read from guest memory without null-returning Mem API
function getMem(ctx: OpenGLContext): Uint8Array { return ctx.process.getCurrentMemory(); }

function pushVertex(ctx: OpenGLContext, x: number, y: number, z: number, w: number): void {
    let buf = ctx.immediateFlatBuf;
    const base = ctx.immediateFlatCount * VERT_FLOATS;
    // Grow if needed
    if (base + VERT_FLOATS > buf.length) {
        const newBuf = new Float32Array(buf.length * 2);
        newBuf.set(buf);
        ctx.immediateFlatBuf = newBuf;
        buf = newBuf;
    }
    const b = ctx.immediateFlatCount * VERT_FLOATS;
    buf[b]    = x;  buf[b+1]  = y;  buf[b+2]  = z;  buf[b+3]  = w;
    buf[b+4]  = ctx.currentColor[0];  buf[b+5]  = ctx.currentColor[1];
    buf[b+6]  = ctx.currentColor[2];  buf[b+7]  = ctx.currentColor[3];
    buf[b+8]  = ctx.currentNormal[0]; buf[b+9]  = ctx.currentNormal[1]; buf[b+10] = ctx.currentNormal[2];
    buf[b+11] = ctx.currentTexCoord[0][0]; buf[b+12] = ctx.currentTexCoord[0][1];
    buf[b+13] = ctx.currentTexCoord[1][0]; buf[b+14] = ctx.currentTexCoord[1][1];
    ctx.immediateFlatCount++;
}

/** Write a GLDrawVertex object into the flat immediate buffer. Used by arrays.ts bridge. */
export function pushVertexObj(ctx: OpenGLContext, v: GLDrawVertex): void {
    let buf = ctx.immediateFlatBuf;
    const base = ctx.immediateFlatCount * VERT_FLOATS;
    if (base + VERT_FLOATS > buf.length) {
        const newBuf = new Float32Array(buf.length * 2);
        newBuf.set(buf);
        ctx.immediateFlatBuf = newBuf;
        buf = newBuf;
    }
    const b = ctx.immediateFlatCount * VERT_FLOATS;
    buf[b]    = v.x;  buf[b+1]  = v.y;  buf[b+2]  = v.z;  buf[b+3]  = v.w;
    buf[b+4]  = v.r;  buf[b+5]  = v.g;  buf[b+6]  = v.b;  buf[b+7]  = v.a;
    buf[b+8]  = v.nx; buf[b+9]  = v.ny; buf[b+10] = v.nz;
    buf[b+11] = v.s0; buf[b+12] = v.t0; buf[b+13] = v.s1; buf[b+14] = v.t1;
    ctx.immediateFlatCount++;
}

export function assembleFlatVerts(src: Float32Array, srcCount: number, mode: number, dst: Float32Array): number {
    let dc = 0;
    function cp(d: number, s: number): void {
        dst.set(src.subarray(s * VERT_FLOATS, s * VERT_FLOATS + VERT_FLOATS), d * VERT_FLOATS);
    }
    switch (mode) {
        case GL_TRIANGLES:
            for (let i = 0; i + 2 < srcCount; i += 3) {
                cp(dc++, i); cp(dc++, i+1); cp(dc++, i+2);
            }
            break;
        case GL_TRIANGLE_STRIP:
            for (let i = 0; i + 2 < srcCount; i++) {
                if (i % 2 === 0) { cp(dc++, i); cp(dc++, i+1); cp(dc++, i+2); }
                else             { cp(dc++, i+1); cp(dc++, i); cp(dc++, i+2); }
            }
            break;
        case GL_TRIANGLE_FAN:
        case GL_POLYGON:
            for (let i = 1; i + 1 < srcCount; i++) { cp(dc++, 0); cp(dc++, i); cp(dc++, i+1); }
            break;
        case GL_QUADS:
            for (let i = 0; i + 3 < srcCount; i += 4) {
                cp(dc++, i); cp(dc++, i+1); cp(dc++, i+2);
                cp(dc++, i); cp(dc++, i+2); cp(dc++, i+3);
            }
            break;
        case GL_QUAD_STRIP:
            for (let i = 0; i + 3 < srcCount; i += 2) {
                cp(dc++, i); cp(dc++, i+1); cp(dc++, i+2);
                cp(dc++, i+2); cp(dc++, i+1); cp(dc++, i+3);
            }
            break;
        default:
            // GL_POINTS, GL_LINES, GL_LINE_STRIP, GL_LINE_LOOP: pass through
            for (let i = 0; i < srcCount; i++) cp(dc++, i);
            break;
    }
    return dc;
}

let transformDiagCount = 0;

export function transformFlatVerts(ctx: OpenGLContext, buf: Float32Array, count: number): void {
    const mv = ctx.modelviewStack.stack[ctx.modelviewStack.top];
    const proj = ctx.projectionStack.stack[ctx.projectionStack.top];
    mat4Multiply(_mvpScratch, proj, mv);
    const m = _mvpScratch;

    if (transformDiagCount < 2 && count > 0) {
        transformDiagCount++;
        const b0 = 0;
        Logger.log(LogCategory.SYSTEM,
            `[GL TRANSFORM] verts=${count} viewport=(${ctx.viewportX},${ctx.viewportY},${ctx.viewportW}x${ctx.viewportH}) ` +
            `obj_v0=(${buf[b0].toFixed(1)},${buf[b0+1].toFixed(1)},${buf[b0+2].toFixed(1)},${buf[b0+3].toFixed(1)})`);
        Logger.log(LogCategory.SYSTEM,
            `  proj=[${Array.from(proj).map(v => v.toFixed(4)).join(',')}]`);
        Logger.log(LogCategory.SYSTEM,
            `  mv=[${Array.from(mv).map(v => v.toFixed(4)).join(',')}]`);
        Logger.log(LogCategory.SYSTEM,
            `  mvp=[${Array.from(m).map(v => v.toFixed(4)).join(',')}]`);
    }

    // Output clip-space coordinates directly — GPU handles perspective divide,
    // near/far plane clipping, and viewport transform via setViewport().
    for (let i = 0; i < count; i++) {
        const b = i * VERT_FLOATS;
        const x = buf[b], y = buf[b+1], z = buf[b+2], w = buf[b+3];
        buf[b]   = m[0]*x + m[4]*y + m[8]*z  + m[12]*w;  // clip.x
        buf[b+1] = m[1]*x + m[5]*y + m[9]*z  + m[13]*w;  // clip.y
        buf[b+2] = m[2]*x + m[6]*y + m[10]*z + m[14]*w;  // clip.z
        buf[b+3] = m[3]*x + m[7]*y + m[11]*z + m[15]*w;  // clip.w
    }
}

function computeTexGenCoordFlat(
    mode: number, objPlane: Float32Array, eyePlane: Float32Array,
    coordIndex: number,
    ox: number, oy: number, oz: number, ow: number, // object pos
    ex: number, ey: number, ez: number,              // eye-space pos
    enx: number, eny: number, enz: number,           // eye-space normal
): number {
    switch (mode) {
        case GL_OBJECT_LINEAR:
            return objPlane[0]*ox + objPlane[1]*oy + objPlane[2]*oz + objPlane[3]*ow;
        case GL_EYE_LINEAR:
            return eyePlane[0]*ex + eyePlane[1]*ey + eyePlane[2]*ez + eyePlane[3];
        case GL_SPHERE_MAP: {
            const elen = Math.sqrt(ex*ex + ey*ey + ez*ez);
            const invE = elen > 1e-8 ? 1/elen : 0;
            const ux = ex*invE, uy = ey*invE, uz = ez*invE;
            const dot2 = 2*(ux*enx + uy*eny + uz*enz);
            const rx = ux - dot2*enx;
            const ry = uy - dot2*eny;
            const rz = uz - dot2*enz + 1;
            const mm = 2*Math.sqrt(rx*rx + ry*ry + rz*rz);
            if (mm < 1e-8) return 0.5;
            return (coordIndex === 0 ? rx : ry) / mm + 0.5;
        }
        default:
            return 0;
    }
}

export function applyTexGenFlat(ctx: OpenGLContext, buf: Float32Array, count: number): void {
    const genS = ctx.enableFlags.has(GL_TEXTURE_GEN_S);
    const genT = ctx.enableFlags.has(GL_TEXTURE_GEN_T);
    if (!genS && !genT) return;

    const mv = ctx.modelviewStack.stack[ctx.modelviewStack.top];

    for (let i = 0; i < count; i++) {
        const b = i * VERT_FLOATS;
        const ox = buf[b], oy = buf[b+1], oz = buf[b+2], ow = buf[b+3];
        const onx = buf[b+8], ony = buf[b+9], onz = buf[b+10];

        // Eye-space position
        const ex = mv[0]*ox + mv[4]*oy + mv[8]*oz  + mv[12]*ow;
        const ey = mv[1]*ox + mv[5]*oy + mv[9]*oz  + mv[13]*ow;
        const ez = mv[2]*ox + mv[6]*oy + mv[10]*oz + mv[14]*ow;

        // Eye-space normal
        let enx = mv[0]*onx + mv[4]*ony + mv[8]*onz;
        let eny = mv[1]*onx + mv[5]*ony + mv[9]*onz;
        let enz = mv[2]*onx + mv[6]*ony + mv[10]*onz;
        const nlen = Math.sqrt(enx*enx + eny*eny + enz*enz);
        if (nlen > 1e-8) { enx /= nlen; eny /= nlen; enz /= nlen; }

        if (genS) buf[b+11] = computeTexGenCoordFlat(ctx.texGenS.mode, ctx.texGenS.objectPlane, ctx.texGenS.eyePlane, 0, ox, oy, oz, ow, ex, ey, ez, enx, eny, enz);
        if (genT) buf[b+12] = computeTexGenCoordFlat(ctx.texGenT.mode, ctx.texGenT.objectPlane, ctx.texGenT.eyePlane, 1, ox, oy, oz, ow, ex, ey, ez, enx, eny, enz);
    }
}

function pushGLDrawCommand(ctx: OpenGLContext, mode: number, vertData: Float32Array, vertCount: number): void {
    const unit0 = ctx.textureUnits[0];
    const unit1 = ctx.textureUnits[1];
    const fc = ctx.fogColor;

    const cmd: GLDrawCommand = {
        type: GLDrawCommandType.DRAW,
        mode,
        vertData,
        vertCount,
        depthTest: ctx.enableFlags.has(0x0B71),
        depthFunc: ctx.depthFunc,
        depthMask: ctx.depthMask,
        blendEnabled: ctx.enableFlags.has(0x0BE2),
        blendSrc: ctx.blendSrc,
        blendDst: ctx.blendDst,
        alphaTest: ctx.enableFlags.has(0x0BC0),
        alphaFunc: ctx.alphaFunc,
        alphaRef: ctx.alphaRef,
        cullEnabled: ctx.enableFlags.has(0x0B44),
        cullFace: ctx.cullFace,
        frontFace: ctx.frontFace,
        textureId0: unit0.enabled2d ? unit0.boundTexture : 0,
        textureId1: unit1.enabled2d ? unit1.boundTexture : 0,
        texEnvMode0: unit0.texEnvMode,
        texEnvMode1: unit1.texEnvMode,
        shadeModel: ctx.shadeModel,
        fogEnabled: ctx.enableFlags.has(0x0B60),
        fogMode: ctx.fogMode,
        fogR: fc[0], fogG: fc[1], fogB: fc[2], fogA: fc[3],
        fogDensity: ctx.fogDensity,
        fogStart: ctx.fogStart,
        fogEnd: ctx.fogEnd,
        polygonMode: ctx.polygonModeFront,
        colorMaskR: ctx.colorMaskR,
        colorMaskG: ctx.colorMaskG,
        colorMaskB: ctx.colorMaskB,
        colorMaskA: ctx.colorMaskA,
        stencilTest: ctx.enableFlags.has(GL_STENCIL_TEST),
        stencilFunc: ctx.stencilFunc,
        stencilRef: ctx.stencilRef,
        stencilMask: ctx.stencilMask,
        stencilFail: ctx.stencilFail,
        stencilZFail: ctx.stencilZFail,
        stencilZPass: ctx.stencilZPass,
        stencilWriteMask: ctx.stencilWriteMask,
        scissorEnabled: ctx.enableFlags.has(0x0C11),
        scissorX: ctx.scissorX, scissorY: ctx.scissorY, scissorW: ctx.scissorW, scissorH: ctx.scissorH,
        vpX: ctx.viewportX, vpY: ctx.viewportY, vpW: ctx.viewportW, vpH: ctx.viewportH,
        depthRangeNear: ctx.depthRangeNear,
        depthRangeFar: ctx.depthRangeFar,
    };

    ctx.commands.push(cmd);
    ctx.frameSnapshot.drawCalls++;
    ctx.frameSnapshot.vertexCount += vertCount;
}

export function emitDrawCommandFlat(ctx: OpenGLContext, mode: number, src: Float32Array, srcCount: number): void {
    const asmCount = assembleFlatVerts(src, srcCount, mode, _asmBuf);
    if (asmCount === 0) return;

    if (ctx.enableFlags.has(GL_TEXTURE_GEN_S) || ctx.enableFlags.has(GL_TEXTURE_GEN_T)) {
        applyTexGenFlat(ctx, _asmBuf, asmCount);
    }

    // Snapshot — command owns its data
    const vertData = new Float32Array(asmCount * VERT_FLOATS);
    vertData.set(_asmBuf.subarray(0, asmCount * VERT_FLOATS));
    transformFlatVerts(ctx, vertData, asmCount);

    pushGLDrawCommand(ctx, mode, vertData, asmCount);
}

/** For pre-baked display list items — data is already triangle-assembled, apply texgen + transform now */
export function emitDrawCommandFromPrebaked(ctx: OpenGLContext, mode: number, flatVerts: Float32Array, count: number): void {
    if (count === 0) return;

    const vertData = new Float32Array(count * VERT_FLOATS);
    vertData.set(flatVerts.subarray(0, count * VERT_FLOATS));

    if (ctx.enableFlags.has(GL_TEXTURE_GEN_S) || ctx.enableFlags.has(GL_TEXTURE_GEN_T)) {
        applyTexGenFlat(ctx, vertData, count);
    }
    transformFlatVerts(ctx, vertData, count);

    pushGLDrawCommand(ctx, mode, vertData, count);
}

/** Bridge for arrays.ts: accepts GLDrawVertex[] objects and converts to flat format */
export function emitDrawCommand(ctx: OpenGLContext, mode: number, verts: GLDrawVertex[]): void {
    const count = verts.length;
    if (count === 0) return;
    const tmpBuf = new Float32Array(count * VERT_FLOATS);
    for (let i = 0; i < count; i++) {
        const v = verts[i];
        const b = i * VERT_FLOATS;
        tmpBuf[b]=v.x; tmpBuf[b+1]=v.y; tmpBuf[b+2]=v.z; tmpBuf[b+3]=v.w;
        tmpBuf[b+4]=v.r; tmpBuf[b+5]=v.g; tmpBuf[b+6]=v.b; tmpBuf[b+7]=v.a;
        tmpBuf[b+8]=v.nx; tmpBuf[b+9]=v.ny; tmpBuf[b+10]=v.nz;
        tmpBuf[b+11]=v.s0; tmpBuf[b+12]=v.t0; tmpBuf[b+13]=v.s1; tmpBuf[b+14]=v.t1;
    }
    emitDrawCommandFlat(ctx, mode, tmpBuf, count);
}

export function createImmediateExports(ctx: OpenGLContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['glBegin'] = (_c, _m, args): number => {
        if (ctx.immediateMode) {
            ctx.error = GL_INVALID_OPERATION;
            return 0;
        }
        ctx.immediateMode = true;
        ctx.immediatePrimMode = args[0] >>> 0;
        ctx.immediateFlatCount = 0;
        return 0;
    };

    exports['glEnd'] = (): number => {
        if (!ctx.immediateMode) {
            ctx.error = GL_INVALID_OPERATION;
            return 0;
        }
        ctx.immediateMode = false;
        emitDrawCommandFlat(ctx, ctx.immediatePrimMode, ctx.immediateFlatBuf, ctx.immediateFlatCount);
        ctx.immediateFlatCount = 0;
        return 0;
    };

    // glVertex variants
    exports['glVertex2f'] = (_c, _m, args): number => {
        pushVertex(ctx, bitsToF32(args[0]), bitsToF32(args[1]), 0, 1);
        return 0;
    };
    exports['glVertex3f'] = (_c, _m, args): number => {
        pushVertex(ctx, bitsToF32(args[0]), bitsToF32(args[1]), bitsToF32(args[2]), 1);
        return 0;
    };
    exports['glVertex4f'] = (_c, _m, args): number => {
        pushVertex(ctx, bitsToF32(args[0]), bitsToF32(args[1]), bitsToF32(args[2]), bitsToF32(args[3]));
        return 0;
    };
    exports['glVertex2d'] = (_c, _m, args): number => {
        pushVertex(ctx, args[0] as number, args[1] as number, 0, 1);
        return 0;
    };
    exports['glVertex3d'] = (_c, _m, args): number => {
        pushVertex(ctx, args[0] as number, args[1] as number, args[2] as number, 1);
        return 0;
    };
    exports['glVertex4d'] = (_c, _m, args): number => {
        pushVertex(ctx, args[0] as number, args[1] as number, args[2] as number, args[3] as number);
        return 0;
    };
    exports['glVertex2i'] = (_c, _m, args): number => {
        pushVertex(ctx, args[0] | 0, args[1] | 0, 0, 1);
        return 0;
    };
    exports['glVertex3i'] = (_c, _m, args): number => {
        pushVertex(ctx, args[0] | 0, args[1] | 0, args[2] | 0, 1);
        return 0;
    };
    exports['glVertex4i'] = (_c, _m, args): number => {
        pushVertex(ctx, args[0] | 0, args[1] | 0, args[2] | 0, args[3] | 0);
        return 0;
    };
    exports['glVertex2s'] = exports['glVertex2i'];
    exports['glVertex3s'] = exports['glVertex3i'];
    exports['glVertex4s'] = exports['glVertex4i'];

    // Vector variants - read from guest ptr using cached DataView
    exports['glVertex2fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getFloat32(ptr, true), dv.getFloat32(ptr+4, true), 0, 1);
        return 0;
    };
    exports['glVertex3fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getFloat32(ptr, true), dv.getFloat32(ptr+4, true), dv.getFloat32(ptr+8, true), 1);
        return 0;
    };
    exports['glVertex4fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getFloat32(ptr, true), dv.getFloat32(ptr+4, true), dv.getFloat32(ptr+8, true), dv.getFloat32(ptr+12, true));
        return 0;
    };
    exports['glVertex2dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getFloat64(ptr, true), dv.getFloat64(ptr+8, true), 0, 1);
        return 0;
    };
    exports['glVertex3dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getFloat64(ptr, true), dv.getFloat64(ptr+8, true), dv.getFloat64(ptr+16, true), 1);
        return 0;
    };
    exports['glVertex4dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getFloat64(ptr, true), dv.getFloat64(ptr+8, true), dv.getFloat64(ptr+16, true), dv.getFloat64(ptr+24, true));
        return 0;
    };
    exports['glVertex2iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getInt32(ptr, true), dv.getInt32(ptr+4, true), 0, 1);
        return 0;
    };
    exports['glVertex3iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getInt32(ptr, true), dv.getInt32(ptr+4, true), dv.getInt32(ptr+8, true), 1);
        return 0;
    };
    exports['glVertex4iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getInt32(ptr, true), dv.getInt32(ptr+4, true), dv.getInt32(ptr+8, true), dv.getInt32(ptr+12, true));
        return 0;
    };
    exports['glVertex2sv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getInt16(ptr, true), dv.getInt16(ptr+2, true), 0, 1);
        return 0;
    };
    exports['glVertex3sv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getInt16(ptr, true), dv.getInt16(ptr+2, true), dv.getInt16(ptr+4, true), 1);
        return 0;
    };
    exports['glVertex4sv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        pushVertex(ctx, dv.getInt16(ptr, true), dv.getInt16(ptr+2, true), dv.getInt16(ptr+4, true), dv.getInt16(ptr+6, true));
        return 0;
    };

    // glColor variants
    exports['glColor3f'] = (_c, _m, args): number => {
        ctx.currentColor[0] = bitsToF32(args[0]);
        ctx.currentColor[1] = bitsToF32(args[1]);
        ctx.currentColor[2] = bitsToF32(args[2]);
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4f'] = (_c, _m, args): number => {
        ctx.currentColor[0] = bitsToF32(args[0]);
        ctx.currentColor[1] = bitsToF32(args[1]);
        ctx.currentColor[2] = bitsToF32(args[2]);
        ctx.currentColor[3] = bitsToF32(args[3]);
        return 0;
    };
    exports['glColor3ub'] = (_c, _m, args): number => {
        ctx.currentColor[0] = (args[0] & 0xFF) / 255;
        ctx.currentColor[1] = (args[1] & 0xFF) / 255;
        ctx.currentColor[2] = (args[2] & 0xFF) / 255;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4ub'] = (_c, _m, args): number => {
        ctx.currentColor[0] = (args[0] & 0xFF) / 255;
        ctx.currentColor[1] = (args[1] & 0xFF) / 255;
        ctx.currentColor[2] = (args[2] & 0xFF) / 255;
        ctx.currentColor[3] = (args[3] & 0xFF) / 255;
        return 0;
    };
    exports['glColor3d'] = (_c, _m, args): number => {
        ctx.currentColor[0] = args[0] as number;
        ctx.currentColor[1] = args[1] as number;
        ctx.currentColor[2] = args[2] as number;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4d'] = (_c, _m, args): number => {
        ctx.currentColor[0] = args[0] as number;
        ctx.currentColor[1] = args[1] as number;
        ctx.currentColor[2] = args[2] as number;
        ctx.currentColor[3] = args[3] as number;
        return 0;
    };
    exports['glColor3b'] = (_c, _m, args): number => {
        ctx.currentColor[0] = ((args[0] << 24) >> 24) / 127;
        ctx.currentColor[1] = ((args[1] << 24) >> 24) / 127;
        ctx.currentColor[2] = ((args[2] << 24) >> 24) / 127;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4b'] = (_c, _m, args): number => {
        ctx.currentColor[0] = ((args[0] << 24) >> 24) / 127;
        ctx.currentColor[1] = ((args[1] << 24) >> 24) / 127;
        ctx.currentColor[2] = ((args[2] << 24) >> 24) / 127;
        ctx.currentColor[3] = ((args[3] << 24) >> 24) / 127;
        return 0;
    };
    exports['glColor3i'] = (_c, _m, args): number => {
        ctx.currentColor[0] = (args[0] | 0) / 2147483647;
        ctx.currentColor[1] = (args[1] | 0) / 2147483647;
        ctx.currentColor[2] = (args[2] | 0) / 2147483647;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4i'] = (_c, _m, args): number => {
        ctx.currentColor[0] = (args[0] | 0) / 2147483647;
        ctx.currentColor[1] = (args[1] | 0) / 2147483647;
        ctx.currentColor[2] = (args[2] | 0) / 2147483647;
        ctx.currentColor[3] = (args[3] | 0) / 2147483647;
        return 0;
    };
    exports['glColor3s'] = (_c, _m, args): number => {
        ctx.currentColor[0] = ((args[0] << 16) >> 16) / 32767;
        ctx.currentColor[1] = ((args[1] << 16) >> 16) / 32767;
        ctx.currentColor[2] = ((args[2] << 16) >> 16) / 32767;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4s'] = (_c, _m, args): number => {
        ctx.currentColor[0] = ((args[0] << 16) >> 16) / 32767;
        ctx.currentColor[1] = ((args[1] << 16) >> 16) / 32767;
        ctx.currentColor[2] = ((args[2] << 16) >> 16) / 32767;
        ctx.currentColor[3] = ((args[3] << 16) >> 16) / 32767;
        return 0;
    };
    exports['glColor3ui'] = (_c, _m, args): number => {
        ctx.currentColor[0] = (args[0] >>> 0) / 4294967295;
        ctx.currentColor[1] = (args[1] >>> 0) / 4294967295;
        ctx.currentColor[2] = (args[2] >>> 0) / 4294967295;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4ui'] = (_c, _m, args): number => {
        ctx.currentColor[0] = (args[0] >>> 0) / 4294967295;
        ctx.currentColor[1] = (args[1] >>> 0) / 4294967295;
        ctx.currentColor[2] = (args[2] >>> 0) / 4294967295;
        ctx.currentColor[3] = (args[3] >>> 0) / 4294967295;
        return 0;
    };
    exports['glColor3us'] = (_c, _m, args): number => {
        ctx.currentColor[0] = (args[0] & 0xFFFF) / 65535;
        ctx.currentColor[1] = (args[1] & 0xFFFF) / 65535;
        ctx.currentColor[2] = (args[2] & 0xFFFF) / 65535;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4us'] = (_c, _m, args): number => {
        ctx.currentColor[0] = (args[0] & 0xFFFF) / 65535;
        ctx.currentColor[1] = (args[1] & 0xFFFF) / 65535;
        ctx.currentColor[2] = (args[2] & 0xFFFF) / 65535;
        ctx.currentColor[3] = (args[3] & 0xFFFF) / 65535;
        return 0;
    };

    // Vector color variants
    exports['glColor3fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getFloat32(ptr, true);
        ctx.currentColor[1] = dv.getFloat32(ptr+4, true);
        ctx.currentColor[2] = dv.getFloat32(ptr+8, true);
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getFloat32(ptr, true);
        ctx.currentColor[1] = dv.getFloat32(ptr+4, true);
        ctx.currentColor[2] = dv.getFloat32(ptr+8, true);
        ctx.currentColor[3] = dv.getFloat32(ptr+12, true);
        return 0;
    };
    exports['glColor3dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getFloat64(ptr, true);
        ctx.currentColor[1] = dv.getFloat64(ptr+8, true);
        ctx.currentColor[2] = dv.getFloat64(ptr+16, true);
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getFloat64(ptr, true);
        ctx.currentColor[1] = dv.getFloat64(ptr+8, true);
        ctx.currentColor[2] = dv.getFloat64(ptr+16, true);
        ctx.currentColor[3] = dv.getFloat64(ptr+24, true);
        return 0;
    };
    exports['glColor3bv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0; const mem = getMem(ctx);
        ctx.currentColor[0] = ((mem[ptr] << 24) >> 24) / 127;
        ctx.currentColor[1] = ((mem[ptr + 1] << 24) >> 24) / 127;
        ctx.currentColor[2] = ((mem[ptr + 2] << 24) >> 24) / 127;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4bv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0; const mem = getMem(ctx);
        ctx.currentColor[0] = ((mem[ptr] << 24) >> 24) / 127;
        ctx.currentColor[1] = ((mem[ptr + 1] << 24) >> 24) / 127;
        ctx.currentColor[2] = ((mem[ptr + 2] << 24) >> 24) / 127;
        ctx.currentColor[3] = ((mem[ptr + 3] << 24) >> 24) / 127;
        return 0;
    };
    exports['glColor3ubv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0; const mem = getMem(ctx);
        ctx.currentColor[0] = mem[ptr] / 255;
        ctx.currentColor[1] = mem[ptr + 1] / 255;
        ctx.currentColor[2] = mem[ptr + 2] / 255;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4ubv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0; const mem = getMem(ctx);
        ctx.currentColor[0] = mem[ptr] / 255;
        ctx.currentColor[1] = mem[ptr + 1] / 255;
        ctx.currentColor[2] = mem[ptr + 2] / 255;
        ctx.currentColor[3] = mem[ptr + 3] / 255;
        return 0;
    };
    exports['glColor3iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getInt32(ptr, true) / 2147483647;
        ctx.currentColor[1] = dv.getInt32(ptr+4, true) / 2147483647;
        ctx.currentColor[2] = dv.getInt32(ptr+8, true) / 2147483647;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getInt32(ptr, true) / 2147483647;
        ctx.currentColor[1] = dv.getInt32(ptr+4, true) / 2147483647;
        ctx.currentColor[2] = dv.getInt32(ptr+8, true) / 2147483647;
        ctx.currentColor[3] = dv.getInt32(ptr+12, true) / 2147483647;
        return 0;
    };
    exports['glColor3sv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getInt16(ptr, true) / 32767;
        ctx.currentColor[1] = dv.getInt16(ptr+2, true) / 32767;
        ctx.currentColor[2] = dv.getInt16(ptr+4, true) / 32767;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4sv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getInt16(ptr, true) / 32767;
        ctx.currentColor[1] = dv.getInt16(ptr+2, true) / 32767;
        ctx.currentColor[2] = dv.getInt16(ptr+4, true) / 32767;
        ctx.currentColor[3] = dv.getInt16(ptr+6, true) / 32767;
        return 0;
    };
    exports['glColor3uiv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getUint32(ptr, true) / 4294967295;
        ctx.currentColor[1] = dv.getUint32(ptr + 4, true) / 4294967295;
        ctx.currentColor[2] = dv.getUint32(ptr + 8, true) / 4294967295;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4uiv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getUint32(ptr, true) / 4294967295;
        ctx.currentColor[1] = dv.getUint32(ptr + 4, true) / 4294967295;
        ctx.currentColor[2] = dv.getUint32(ptr + 8, true) / 4294967295;
        ctx.currentColor[3] = dv.getUint32(ptr + 12, true) / 4294967295;
        return 0;
    };
    exports['glColor3usv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getUint16(ptr, true) / 65535;
        ctx.currentColor[1] = dv.getUint16(ptr + 2, true) / 65535;
        ctx.currentColor[2] = dv.getUint16(ptr + 4, true) / 65535;
        ctx.currentColor[3] = 1;
        return 0;
    };
    exports['glColor4usv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentColor[0] = dv.getUint16(ptr, true) / 65535;
        ctx.currentColor[1] = dv.getUint16(ptr + 2, true) / 65535;
        ctx.currentColor[2] = dv.getUint16(ptr + 4, true) / 65535;
        ctx.currentColor[3] = dv.getUint16(ptr + 6, true) / 65535;
        return 0;
    };

    // glNormal variants
    exports['glNormal3f'] = (_c, _m, args): number => {
        ctx.currentNormal[0] = bitsToF32(args[0]);
        ctx.currentNormal[1] = bitsToF32(args[1]);
        ctx.currentNormal[2] = bitsToF32(args[2]);
        return 0;
    };
    exports['glNormal3fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentNormal[0] = dv.getFloat32(ptr, true);
        ctx.currentNormal[1] = dv.getFloat32(ptr+4, true);
        ctx.currentNormal[2] = dv.getFloat32(ptr+8, true);
        return 0;
    };
    exports['glNormal3d'] = (_c, _m, args): number => {
        ctx.currentNormal[0] = args[0] as number;
        ctx.currentNormal[1] = args[1] as number;
        ctx.currentNormal[2] = args[2] as number;
        return 0;
    };
    exports['glNormal3dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentNormal[0] = dv.getFloat64(ptr, true);
        ctx.currentNormal[1] = dv.getFloat64(ptr+8, true);
        ctx.currentNormal[2] = dv.getFloat64(ptr+16, true);
        return 0;
    };
    exports['glNormal3b'] = (_c, _m, args): number => {
        ctx.currentNormal[0] = ((args[0] << 24) >> 24) / 127;
        ctx.currentNormal[1] = ((args[1] << 24) >> 24) / 127;
        ctx.currentNormal[2] = ((args[2] << 24) >> 24) / 127;
        return 0;
    };
    exports['glNormal3bv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0; const mem = getMem(ctx);
        ctx.currentNormal[0] = ((mem[ptr] << 24) >> 24) / 127;
        ctx.currentNormal[1] = ((mem[ptr + 1] << 24) >> 24) / 127;
        ctx.currentNormal[2] = ((mem[ptr + 2] << 24) >> 24) / 127;
        return 0;
    };
    exports['glNormal3i'] = (_c, _m, args): number => {
        ctx.currentNormal[0] = (args[0] | 0) / 2147483647;
        ctx.currentNormal[1] = (args[1] | 0) / 2147483647;
        ctx.currentNormal[2] = (args[2] | 0) / 2147483647;
        return 0;
    };
    exports['glNormal3iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentNormal[0] = dv.getInt32(ptr, true) / 2147483647;
        ctx.currentNormal[1] = dv.getInt32(ptr+4, true) / 2147483647;
        ctx.currentNormal[2] = dv.getInt32(ptr+8, true) / 2147483647;
        return 0;
    };
    exports['glNormal3s'] = (_c, _m, args): number => {
        ctx.currentNormal[0] = ((args[0] << 16) >> 16) / 32767;
        ctx.currentNormal[1] = ((args[1] << 16) >> 16) / 32767;
        ctx.currentNormal[2] = ((args[2] << 16) >> 16) / 32767;
        return 0;
    };
    exports['glNormal3sv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentNormal[0] = dv.getInt16(ptr, true) / 32767;
        ctx.currentNormal[1] = dv.getInt16(ptr+2, true) / 32767;
        ctx.currentNormal[2] = dv.getInt16(ptr+4, true) / 32767;
        return 0;
    };

    // glTexCoord variants
    exports['glTexCoord1f'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = bitsToF32(args[0]);
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = 0;
        return 0;
    };
    exports['glTexCoord2f'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = bitsToF32(args[0]);
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = bitsToF32(args[1]);
        return 0;
    };
    exports['glTexCoord3f'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = bitsToF32(args[0]);
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = bitsToF32(args[1]);
        ctx.currentTexCoord[ctx.activeTextureUnit][2] = bitsToF32(args[2]);
        return 0;
    };
    exports['glTexCoord4f'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = bitsToF32(args[0]);
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = bitsToF32(args[1]);
        ctx.currentTexCoord[ctx.activeTextureUnit][2] = bitsToF32(args[2]);
        ctx.currentTexCoord[ctx.activeTextureUnit][3] = bitsToF32(args[3]);
        return 0;
    };
    exports['glTexCoord1d'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = args[0] as number;
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = 0;
        return 0;
    };
    exports['glTexCoord2d'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = args[0] as number;
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = args[1] as number;
        return 0;
    };
    exports['glTexCoord3d'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = args[0] as number;
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = args[1] as number;
        ctx.currentTexCoord[ctx.activeTextureUnit][2] = args[2] as number;
        return 0;
    };
    exports['glTexCoord4d'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = args[0] as number;
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = args[1] as number;
        ctx.currentTexCoord[ctx.activeTextureUnit][2] = args[2] as number;
        ctx.currentTexCoord[ctx.activeTextureUnit][3] = args[3] as number;
        return 0;
    };
    exports['glTexCoord1i'] = (_c, _m, args): number => { ctx.currentTexCoord[ctx.activeTextureUnit][0] = args[0] | 0; return 0; };
    exports['glTexCoord2i'] = (_c, _m, args): number => { ctx.currentTexCoord[ctx.activeTextureUnit][0] = args[0] | 0; ctx.currentTexCoord[ctx.activeTextureUnit][1] = args[1] | 0; return 0; };
    exports['glTexCoord3i'] = (_c, _m, args): number => { const tc = ctx.currentTexCoord[ctx.activeTextureUnit]; tc[0] = args[0] | 0; tc[1] = args[1] | 0; tc[2] = args[2] | 0; return 0; };
    exports['glTexCoord4i'] = (_c, _m, args): number => { const tc = ctx.currentTexCoord[ctx.activeTextureUnit]; tc[0] = args[0] | 0; tc[1] = args[1] | 0; tc[2] = args[2] | 0; tc[3] = args[3] | 0; return 0; };
    exports['glTexCoord1s'] = exports['glTexCoord1i'];
    exports['glTexCoord2s'] = exports['glTexCoord2i'];
    exports['glTexCoord3s'] = exports['glTexCoord3i'];
    exports['glTexCoord4s'] = exports['glTexCoord4i'];

    // Vector tex coord variants — use cached DataView
    exports['glTexCoord1fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = getMemDV(ctx).getFloat32(ptr, true);
        return 0;
    };
    exports['glTexCoord2fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = dv.getFloat32(ptr, true);
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = dv.getFloat32(ptr+4, true);
        return 0;
    };
    exports['glTexCoord3fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        const tc = ctx.currentTexCoord[ctx.activeTextureUnit];
        tc[0] = dv.getFloat32(ptr, true); tc[1] = dv.getFloat32(ptr+4, true); tc[2] = dv.getFloat32(ptr+8, true);
        return 0;
    };
    exports['glTexCoord4fv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        const tc = ctx.currentTexCoord[ctx.activeTextureUnit];
        tc[0] = dv.getFloat32(ptr, true); tc[1] = dv.getFloat32(ptr+4, true); tc[2] = dv.getFloat32(ptr+8, true); tc[3] = dv.getFloat32(ptr+12, true);
        return 0;
    };
    exports['glTexCoord1dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = getMemDV(ctx).getFloat64(ptr, true);
        return 0;
    };
    exports['glTexCoord2dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = dv.getFloat64(ptr, true);
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = dv.getFloat64(ptr+8, true);
        return 0;
    };
    exports['glTexCoord3dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        const tc = ctx.currentTexCoord[ctx.activeTextureUnit];
        tc[0] = dv.getFloat64(ptr, true); tc[1] = dv.getFloat64(ptr+8, true); tc[2] = dv.getFloat64(ptr+16, true);
        return 0;
    };
    exports['glTexCoord4dv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        const tc = ctx.currentTexCoord[ctx.activeTextureUnit];
        tc[0] = dv.getFloat64(ptr, true); tc[1] = dv.getFloat64(ptr+8, true); tc[2] = dv.getFloat64(ptr+16, true); tc[3] = dv.getFloat64(ptr+24, true);
        return 0;
    };
    exports['glTexCoord1iv'] = (_c, _m, args): number => {
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = getMemDV(ctx).getInt32(args[0] >>> 0, true);
        return 0;
    };
    exports['glTexCoord2iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        ctx.currentTexCoord[ctx.activeTextureUnit][0] = dv.getInt32(ptr, true);
        ctx.currentTexCoord[ctx.activeTextureUnit][1] = dv.getInt32(ptr+4, true);
        return 0;
    };
    exports['glTexCoord3iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        const tc = ctx.currentTexCoord[ctx.activeTextureUnit];
        tc[0] = dv.getInt32(ptr, true); tc[1] = dv.getInt32(ptr+4, true); tc[2] = dv.getInt32(ptr+8, true);
        return 0;
    };
    exports['glTexCoord4iv'] = (_c, _m, args): number => {
        const ptr = args[0] >>> 0;
        const dv = getMemDV(ctx);
        const tc = ctx.currentTexCoord[ctx.activeTextureUnit];
        tc[0] = dv.getInt32(ptr, true); tc[1] = dv.getInt32(ptr+4, true); tc[2] = dv.getInt32(ptr+8, true); tc[3] = dv.getInt32(ptr+12, true);
        return 0;
    };
    exports['glTexCoord1sv'] = exports['glTexCoord1iv'];
    exports['glTexCoord2sv'] = exports['glTexCoord2iv'];
    exports['glTexCoord3sv'] = exports['glTexCoord3iv'];
    exports['glTexCoord4sv'] = exports['glTexCoord4iv'];

    return exports;
}

/**
 * Register Tier-0 write-buffer stubs for the highest-frequency OpenGL immediate-mode functions.
 *
 * These functions (glVertex*, glNormal*, glTexCoord*, glColor*) account for the bulk of
 * OUT-trap overhead in games using immediate mode.  Replacing them with JMP-trampoline stubs
 * saves ~75 ms/frame on a typical OpenGL game (140K glVertex3fv calls × 7 µs each).
 *
 * Flush triggers (glEnd, glFlush, wglSwapBuffers) remain as OUT traps.  drainWriteBuffer()
 * is called at the top of handlePortWrite(), so all buffered vertex data is applied before
 * glEnd's emitDrawCommandFlat() runs.
 *
 * Display-list recording: each handler checks ctx.compilingList.  During GL_COMPILE the
 * args are recorded into compilingCommands and execution is skipped.  During
 * GL_COMPILE_AND_EXECUTE they are recorded AND executed.
 */
export function registerWriteBufferGLFunctions(dispatcher: any, ctx: OpenGLContext): void {
    if (typeof dispatcher.registerWriteBufferFunction !== 'function') return;

    // GL_COMPILE = 0x1300.  Inline the constant to avoid an extra import at hot-path drain time.
    const _GL_COMPILE = 0x1300;

    // Wraps a WBUF handler to support display-list recording.
    // `readArgs` extracts the arg array from the ring buffer (same values the normal thunk
    // would pass in `args[]`).  When compiling a list we push {fn, args} and optionally
    // skip execution (GL_COMPILE).
    const reg = (name: string, argCount: number, readArgs: (mem32: Uint32Array, ptr: number) => number[], handler: WriteBufHandler) => {
        const wrapped: WriteBufHandler = (mem8, mem32, ptr) => {
            if (ctx.compilingList !== null) {
                ctx.compilingCommands.push({ fn: name, args: readArgs(mem32, ptr) });
                if (ctx.compilingListMode === _GL_COMPILE) return;
            }
            handler(mem8, mem32, ptr);
        };
        dispatcher.registerWriteBufferFunction('opengl32', name, argCount, wrapped, true /* stdcall */);
    };

    // --- Pointer-dereference WBUF variants ---
    // These use PtrDeref trampolines that dereference the float* inline in x86,
    // writing actual float bits to the ring buffer (not the pointer).
    // Drain side is identical to the scalar variants.
    // IMPORTANT: display-list recording uses the SCALAR function name (e.g. 'glVertex3f'
    // instead of 'glVertex3fv') because the ring contains float bits, not a pointer.
    // lists.ts replay for *fv variants treats args[0] as a pointer — using the scalar
    // name ensures the replay switch-case interprets the args as float bits correctly.
    if (typeof dispatcher.registerPtrDerefWriteBufferFunction === 'function') {
        const regPd = (name: string, scalarName: string, floatCount: number, readArgs: (mem32: Uint32Array, ptr: number) => number[], handler: WriteBufHandler) => {
            const wrapped: WriteBufHandler = (mem8, mem32, ptr) => {
                if (ctx.compilingList !== null) {
                    ctx.compilingCommands.push({ fn: scalarName, args: readArgs(mem32, ptr) });
                    if (ctx.compilingListMode === _GL_COMPILE) return;
                }
                handler(mem8, mem32, ptr);
            };
            dispatcher.registerPtrDerefWriteBufferFunction('opengl32', name, floatCount, wrapped, true /* stdcall */);
        };

        // glVertex3fv(const GLfloat *v) — ring contains 3 float bits, record as glVertex3f
        regPd('glVertex3fv', 'glVertex3f', 3,
            (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2], m32[(p + 8) >> 2]],
            (_mem8, mem32, ptr) => {
                pushVertex(ctx,
                    bitsToF32(mem32[ptr >> 2]),
                    bitsToF32(mem32[(ptr + 4) >> 2]),
                    bitsToF32(mem32[(ptr + 8) >> 2]),
                    1);
            });

        // glNormal3fv(const GLfloat *v) — ring contains 3 float bits, record as glNormal3f
        regPd('glNormal3fv', 'glNormal3f', 3,
            (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2], m32[(p + 8) >> 2]],
            (_mem8, mem32, ptr) => {
                ctx.currentNormal[0] = bitsToF32(mem32[ptr >> 2]);
                ctx.currentNormal[1] = bitsToF32(mem32[(ptr + 4) >> 2]);
                ctx.currentNormal[2] = bitsToF32(mem32[(ptr + 8) >> 2]);
            });

        // glTexCoord2fv(const GLfloat *v) — ring contains 2 float bits, record as glTexCoord2f
        regPd('glTexCoord2fv', 'glTexCoord2f', 2,
            (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2]],
            (_mem8, mem32, ptr) => {
                const tc = ctx.currentTexCoord[ctx.activeTextureUnit];
                tc[0] = bitsToF32(mem32[ptr >> 2]);
                tc[1] = bitsToF32(mem32[(ptr + 4) >> 2]);
            });
    }

    // --- glVertex3f (x, y, z) ---
    reg('glVertex3f', 3,
        (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2], m32[(p + 8) >> 2]],
        (_mem8, mem32, ptr) => {
            pushVertex(ctx,
                bitsToF32(mem32[ptr >> 2]),
                bitsToF32(mem32[(ptr + 4) >> 2]),
                bitsToF32(mem32[(ptr + 8) >> 2]),
                1);
        });

    // --- glVertex2f (x, y) ---
    reg('glVertex2f', 2,
        (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2]],
        (_mem8, mem32, ptr) => {
            pushVertex(ctx, bitsToF32(mem32[ptr >> 2]), bitsToF32(mem32[(ptr + 4) >> 2]), 0, 1);
        });

    // --- glNormal3f (nx, ny, nz) ---
    reg('glNormal3f', 3,
        (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2], m32[(p + 8) >> 2]],
        (_mem8, mem32, ptr) => {
            ctx.currentNormal[0] = bitsToF32(mem32[ptr >> 2]);
            ctx.currentNormal[1] = bitsToF32(mem32[(ptr + 4) >> 2]);
            ctx.currentNormal[2] = bitsToF32(mem32[(ptr + 8) >> 2]);
        });

    // --- glTexCoord2f (s, t) ---
    reg('glTexCoord2f', 2,
        (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2]],
        (_mem8, mem32, ptr) => {
            const tc = ctx.currentTexCoord[ctx.activeTextureUnit];
            tc[0] = bitsToF32(mem32[ptr >> 2]);
            tc[1] = bitsToF32(mem32[(ptr + 4) >> 2]);
        });

    // --- glColor4f (r, g, b, a) ---
    reg('glColor4f', 4,
        (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2], m32[(p + 8) >> 2], m32[(p + 12) >> 2]],
        (_mem8, mem32, ptr) => {
            ctx.currentColor[0] = bitsToF32(mem32[ptr >> 2]);
            ctx.currentColor[1] = bitsToF32(mem32[(ptr + 4) >> 2]);
            ctx.currentColor[2] = bitsToF32(mem32[(ptr + 8) >> 2]);
            ctx.currentColor[3] = bitsToF32(mem32[(ptr + 12) >> 2]);
        });

    // --- glColor3f (r, g, b) ---
    reg('glColor3f', 3,
        (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2], m32[(p + 8) >> 2]],
        (_mem8, mem32, ptr) => {
            ctx.currentColor[0] = bitsToF32(mem32[ptr >> 2]);
            ctx.currentColor[1] = bitsToF32(mem32[(ptr + 4) >> 2]);
            ctx.currentColor[2] = bitsToF32(mem32[(ptr + 8) >> 2]);
            ctx.currentColor[3] = 1.0;
        });

    // --- glColor4ub (r, g, b, a) — byte args packed as separate u32 words in ring buffer ---
    reg('glColor4ub', 4,
        (m32, p) => [m32[p >> 2], m32[(p + 4) >> 2], m32[(p + 8) >> 2], m32[(p + 12) >> 2]],
        (_mem8, mem32, ptr) => {
            ctx.currentColor[0] = (mem32[ptr >> 2] & 0xFF) / 255;
            ctx.currentColor[1] = (mem32[(ptr + 4) >> 2] & 0xFF) / 255;
            ctx.currentColor[2] = (mem32[(ptr + 8) >> 2] & 0xFF) / 255;
            ctx.currentColor[3] = (mem32[(ptr + 12) >> 2] & 0xFF) / 255;
        });

    Logger.log(LogCategory.SYSTEM,
        'Registered Tier-0 write-buffer stubs for OpenGL immediate-mode functions');
}
