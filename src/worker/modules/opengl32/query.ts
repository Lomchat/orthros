import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Mem } from "../../core/memory/mem-accessor";
import { OpenGLContext } from "./context";
import {
    GL_NO_ERROR, GL_VENDOR, GL_RENDERER, GL_VERSION, GL_EXTENSIONS,
    GL_MAX_TEXTURE_SIZE, GL_MAX_TEXTURE_UNITS, GL_MAX_MODELVIEW_STACK_DEPTH,
    GL_MAX_PROJECTION_STACK_DEPTH, GL_MAX_TEXTURE_STACK_DEPTH, GL_MAX_LIGHTS,
    GL_MAX_CLIP_PLANES, GL_MAX_VIEWPORT_DIMS, GL_MAX_ATTRIB_STACK_DEPTH,
    GL_MAX_CLIENT_ATTRIB_STACK_DEPTH, GL_MAX_ELEMENTS_VERTICES, GL_MAX_ELEMENTS_INDICES,
    GL_VIEWPORT, GL_DEPTH_BITS, GL_STENCIL_BITS,
    GL_DEPTH_RANGE, GL_DEPTH_TEST, GL_BLEND, GL_ALPHA_TEST, GL_CULL_FACE,
    GL_DEPTH_FUNC, GL_DEPTH_WRITEMASK, GL_BLEND_SRC, GL_BLEND_DST, GL_ALPHA_TEST_FUNC,
    GL_ALPHA_TEST_REF, GL_CULL_FACE_MODE, GL_FRONT_FACE, GL_SHADE_MODEL,
    GL_MODELVIEW_MATRIX, GL_PROJECTION_MATRIX, GL_TEXTURE_MATRIX,
    GL_MODELVIEW_STACK_DEPTH, GL_PROJECTION_STACK_DEPTH, GL_TEXTURE_STACK_DEPTH,
    GL_MATRIX_MODE, GL_ACTIVE_TEXTURE, GL_CLIENT_ACTIVE_TEXTURE,
    GL_TEXTURE_BINDING_2D, GL_COLOR_CLEAR_VALUE, GL_COLOR_WRITEMASK,
    GL_SCISSOR_BOX, GL_SCISSOR_TEST, GL_RGBA_MODE, GL_DOUBLEBUFFER,
    GL_UNPACK_ALIGNMENT, GL_PACK_ALIGNMENT, GL_FOG, GL_FOG_MODE, GL_FOG_DENSITY,
    GL_FOG_START, GL_FOG_END, GL_FOG_COLOR, GL_LIGHTING,
    GL_POLYGON_MODE, GL_LINE_WIDTH, GL_POINT_SIZE,
    GL_NUM_COMPRESSED_TEXTURE_FORMATS, GL_COMPRESSED_TEXTURE_FORMATS,
    GL_COMPRESSED_RGB_S3TC_DXT1_EXT, GL_COMPRESSED_RGBA_S3TC_DXT1_EXT,
    GL_COMPRESSED_RGBA_S3TC_DXT3_EXT, GL_COMPRESSED_RGBA_S3TC_DXT5_EXT,
    GL_COMPRESSED_RED_RGTC1, GL_COMPRESSED_SIGNED_RED_RGTC1,
    GL_COMPRESSED_RG_RGTC2, GL_COMPRESSED_SIGNED_RG_RGTC2,
    GL_COMPRESSED_LUMINANCE_LATC1_EXT, GL_COMPRESSED_SIGNED_LUMINANCE_LATC1_EXT,
    GL_COMPRESSED_LUMINANCE_ALPHA_LATC2_EXT, GL_COMPRESSED_SIGNED_LUMINANCE_ALPHA_LATC2_EXT,
    GL_SAMPLE_BUFFERS, GL_SAMPLES,
    GL_TEXTURE0, GL_TRUE, GL_FALSE,
} from "./constants";

const GL_RED_BITS = 0x0D52;
const GL_GREEN_BITS = 0x0D53;
const GL_BLUE_BITS = 0x0D54;
const GL_ALPHA_BITS = 0x0D55;
const COMPRESSED_TEXTURE_FORMATS = [
    GL_COMPRESSED_RGB_S3TC_DXT1_EXT,
    GL_COMPRESSED_RGBA_S3TC_DXT1_EXT,
    GL_COMPRESSED_RGBA_S3TC_DXT3_EXT,
    GL_COMPRESSED_RGBA_S3TC_DXT5_EXT,
    GL_COMPRESSED_RED_RGTC1,
    GL_COMPRESSED_SIGNED_RED_RGTC1,
    GL_COMPRESSED_RG_RGTC2,
    GL_COMPRESSED_SIGNED_RG_RGTC2,
    GL_COMPRESSED_LUMINANCE_LATC1_EXT,
    GL_COMPRESSED_SIGNED_LUMINANCE_LATC1_EXT,
    GL_COMPRESSED_LUMINANCE_ALPHA_LATC2_EXT,
    GL_COMPRESSED_SIGNED_LUMINANCE_ALPHA_LATC2_EXT,
];

export function createQueryExports(ctx: OpenGLContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    function allocGuestString(str: string): number {
        const bytes = new TextEncoder().encode(str + "\0");
        const addr = ctx.process.memory.alloc(bytes.length);
        if (addr) {
            const mem = ctx.process.getCurrentMemory();
            for (let i = 0; i < bytes.length; i++) {
                mem[addr + i] = bytes[i];
            }
        }
        return addr;
    }

    exports['glGetError'] = (): number => {
        const err = ctx.error;
        ctx.error = GL_NO_ERROR;
        return err;
    };

    exports['glGetString'] = (_ctx, _mem, args): number => {
        const name = args[0] >>> 0;
        const cached = ctx.stringCache.get(name);
        if (cached) return cached;

        let str: string;
        switch (name) {
            case GL_VENDOR: str = "Orthros"; break;
            case GL_RENDERER: str = "Orthros WebGPU"; break;
            case GL_VERSION: str = "1.3.0"; break;
            case GL_EXTENSIONS:
                str = "GL_ARB_multitexture GL_EXT_compiled_vertex_array GL_ARB_texture_env_combine GL_ARB_texture_compression GL_EXT_texture_compression_s3tc GL_ARB_texture_compression_rgtc GL_EXT_texture_compression_latc";
                break;
            default: return 0;
        }

        const addr = allocGuestString(str);
        ctx.stringCache.set(name, addr);
        return addr;
    };

    exports['glGetIntegerv'] = (_ctx, _mem, args): number => {
        const pname = args[0] >>> 0;
        const ptr = args[1] >>> 0;
        if (!ptr) return 0;

        const writeInt = (v: number) => Mem.writeUint32(ptr, v);
        const writeInts = (vals: number[]) => { for (let i = 0; i < vals.length; i++) Mem.writeUint32(ptr + i * 4, vals[i]); };

        switch (pname) {
            case GL_MAX_TEXTURE_SIZE: writeInt(2048); break;
            case GL_MAX_TEXTURE_UNITS: writeInt(2); break;
            case GL_MAX_MODELVIEW_STACK_DEPTH: writeInt(32); break;
            case GL_MAX_PROJECTION_STACK_DEPTH: writeInt(32); break;
            case GL_MAX_TEXTURE_STACK_DEPTH: writeInt(32); break;
            case GL_MAX_LIGHTS: writeInt(8); break;
            case GL_MAX_CLIP_PLANES: writeInt(6); break;
            case GL_MAX_VIEWPORT_DIMS: writeInts([4096, 4096]); break;
            case GL_MAX_ATTRIB_STACK_DEPTH: writeInt(16); break;
            case GL_MAX_CLIENT_ATTRIB_STACK_DEPTH: writeInt(16); break;
            case GL_MAX_ELEMENTS_VERTICES: writeInt(65536); break;
            case GL_MAX_ELEMENTS_INDICES: writeInt(65536); break;
            case GL_VIEWPORT: writeInts([ctx.viewportX, ctx.viewportY, ctx.viewportW, ctx.viewportH]); break;
            case GL_SCISSOR_BOX: writeInts([ctx.scissorX, ctx.scissorY, ctx.scissorW, ctx.scissorH]); break;
            case GL_DEPTH_BITS: writeInt(24); break;
            case GL_STENCIL_BITS: writeInt(8); break;
            case GL_RED_BITS: writeInt(8); break;
            case GL_GREEN_BITS: writeInt(8); break;
            case GL_BLUE_BITS: writeInt(8); break;
            case GL_ALPHA_BITS: writeInt(8); break;
            case GL_DEPTH_FUNC: writeInt(ctx.depthFunc); break;
            case GL_DEPTH_WRITEMASK: writeInt(ctx.depthMask ? 1 : 0); break;
            case GL_BLEND_SRC: writeInt(ctx.blendSrc); break;
            case GL_BLEND_DST: writeInt(ctx.blendDst); break;
            case GL_ALPHA_TEST_FUNC: writeInt(ctx.alphaFunc); break;
            case GL_CULL_FACE_MODE: writeInt(ctx.cullFace); break;
            case GL_FRONT_FACE: writeInt(ctx.frontFace); break;
            case GL_SHADE_MODEL: writeInt(ctx.shadeModel); break;
            case GL_MATRIX_MODE: writeInt(ctx.matrixMode); break;
            case GL_ACTIVE_TEXTURE: writeInt(GL_TEXTURE0 + ctx.activeTextureUnit); break;
            case GL_CLIENT_ACTIVE_TEXTURE: writeInt(GL_TEXTURE0 + ctx.clientActiveTextureUnit); break;
            case GL_TEXTURE_BINDING_2D: writeInt(ctx.textureUnits[ctx.activeTextureUnit].boundTexture); break;
            case GL_MODELVIEW_STACK_DEPTH: writeInt(ctx.modelviewStack.top + 1); break;
            case GL_PROJECTION_STACK_DEPTH: writeInt(ctx.projectionStack.top + 1); break;
            case GL_TEXTURE_STACK_DEPTH: writeInt(ctx.textureStack.top + 1); break;
            case GL_COLOR_WRITEMASK: writeInts([ctx.colorMaskR ? 1 : 0, ctx.colorMaskG ? 1 : 0, ctx.colorMaskB ? 1 : 0, ctx.colorMaskA ? 1 : 0]); break;
            case GL_UNPACK_ALIGNMENT: writeInt(ctx.unpackAlignment); break;
            case GL_PACK_ALIGNMENT: writeInt(ctx.packAlignment); break;
            case GL_FOG_MODE: writeInt(ctx.fogMode); break;
            case GL_POLYGON_MODE: writeInts([ctx.polygonModeFront, ctx.polygonModeBack]); break;
            case GL_RGBA_MODE: writeInt(1); break;
            case GL_DOUBLEBUFFER: writeInt(1); break;
            case GL_NUM_COMPRESSED_TEXTURE_FORMATS: writeInt(COMPRESSED_TEXTURE_FORMATS.length); break;
            case GL_COMPRESSED_TEXTURE_FORMATS: writeInts(COMPRESSED_TEXTURE_FORMATS); break;
            case GL_SAMPLE_BUFFERS: writeInt(0); break;
            case GL_SAMPLES: writeInt(0); break;
            default: writeInt(0); break;
        }
        return 0;
    };

    exports['glGetFloatv'] = (_ctx, _mem, args): number => {
        const pname = args[0] >>> 0;
        const ptr = args[1] >>> 0;
        if (!ptr) return 0;

        const mem = ctx.process.getCurrentMemory();
        const view = new DataView(mem.buffer, mem.byteOffset);
        const writeF32 = (v: number) => view.setFloat32(ptr, v, true);
        const writeF32s = (vals: ArrayLike<number>) => { for (let i = 0; i < vals.length; i++) view.setFloat32(ptr + i * 4, vals[i], true); };

        switch (pname) {
            case GL_MODELVIEW_MATRIX: writeF32s(ctx.modelviewStack.stack[ctx.modelviewStack.top]); break;
            case GL_PROJECTION_MATRIX: writeF32s(ctx.projectionStack.stack[ctx.projectionStack.top]); break;
            case GL_TEXTURE_MATRIX: writeF32s(ctx.textureStack.stack[ctx.textureStack.top]); break;
            case GL_DEPTH_RANGE: writeF32s([ctx.depthRangeNear, ctx.depthRangeFar]); break;
            case GL_COLOR_CLEAR_VALUE: writeF32s([ctx.clearR, ctx.clearG, ctx.clearB, ctx.clearA]); break;
            case GL_ALPHA_TEST_REF: writeF32(ctx.alphaRef); break;
            case GL_FOG_DENSITY: writeF32(ctx.fogDensity); break;
            case GL_FOG_START: writeF32(ctx.fogStart); break;
            case GL_FOG_END: writeF32(ctx.fogEnd); break;
            case GL_FOG_COLOR: writeF32s(ctx.fogColor); break;
            case GL_LINE_WIDTH: writeF32(ctx.lineWidth); break;
            case GL_POINT_SIZE: writeF32(ctx.pointSize); break;
            default: writeF32(0); break;
        }
        return 0;
    };

    exports['glGetDoublev'] = (_ctx, _mem, args): number => {
        const pname = args[0] >>> 0;
        const ptr = args[1] >>> 0;
        if (!ptr) return 0;

        const mem = ctx.process.getCurrentMemory();
        const view = new DataView(mem.buffer, mem.byteOffset);
        const writeF64 = (v: number) => view.setFloat64(ptr, v, true);

        switch (pname) {
            case GL_MODELVIEW_MATRIX: {
                const m = ctx.modelviewStack.stack[ctx.modelviewStack.top];
                for (let j = 0; j < 16; j++) view.setFloat64(ptr + j * 8, m[j], true);
                break;
            }
            case GL_PROJECTION_MATRIX: {
                const m = ctx.projectionStack.stack[ctx.projectionStack.top];
                for (let j = 0; j < 16; j++) view.setFloat64(ptr + j * 8, m[j], true);
                break;
            }
            case GL_DEPTH_RANGE:
                view.setFloat64(ptr, ctx.depthRangeNear, true);
                view.setFloat64(ptr + 8, ctx.depthRangeFar, true);
                break;
            default: writeF64(0); break;
        }
        return 0;
    };

    exports['glGetBooleanv'] = (_ctx, _mem, args): number => {
        const pname = args[0] >>> 0;
        const ptr = args[1] >>> 0;
        if (!ptr) return 0;

        let val = 0;
        switch (pname) {
            case GL_DEPTH_TEST: val = ctx.enableFlags.has(GL_DEPTH_TEST) ? 1 : 0; break;
            case GL_BLEND: val = ctx.enableFlags.has(GL_BLEND) ? 1 : 0; break;
            case GL_ALPHA_TEST: val = ctx.enableFlags.has(GL_ALPHA_TEST) ? 1 : 0; break;
            case GL_CULL_FACE: val = ctx.enableFlags.has(GL_CULL_FACE) ? 1 : 0; break;
            case GL_SCISSOR_TEST: val = ctx.enableFlags.has(GL_SCISSOR_TEST) ? 1 : 0; break;
            case GL_FOG: val = ctx.enableFlags.has(GL_FOG) ? 1 : 0; break;
            case GL_LIGHTING: val = ctx.enableFlags.has(GL_LIGHTING) ? 1 : 0; break;
            case GL_DEPTH_WRITEMASK: val = ctx.depthMask ? 1 : 0; break;
            case GL_DOUBLEBUFFER: val = 1; break;
            case GL_RGBA_MODE: val = 1; break;
        }
        const mem = ctx.process.getCurrentMemory();
        mem[ptr] = val;
        return 0;
    };

    exports['glFinish'] = (): number => 0;
    exports['glFlush'] = (): number => 0;

    exports['glIsTexture'] = (_ctx, _mem, args): number => {
        return ctx.textures.has(args[0] >>> 0) ? GL_TRUE : GL_FALSE;
    };

    exports['glIsList'] = (_ctx, _mem, args): number => {
        return ctx.displayLists.has(args[0] >>> 0) ? GL_TRUE : GL_FALSE;
    };

    exports['glIsEnabled'] = (_ctx, _mem, args): number => {
        return ctx.enableFlags.has(args[0] >>> 0) ? GL_TRUE : GL_FALSE;
    };

    // Stub getters that need guest memory writes
    exports['glGetTexEnvfv'] = (): number => 0;
    exports['glGetTexEnviv'] = (): number => 0;
    exports['glGetLightfv'] = (): number => 0;
    exports['glGetLightiv'] = (): number => 0;
    exports['glGetMaterialfv'] = (): number => 0;
    exports['glGetMaterialiv'] = (): number => 0;
    exports['glGetTexParameterfv'] = (): number => 0;
    exports['glGetTexParameteriv'] = (): number => 0;
    exports['glGetTexLevelParameterfv'] = (): number => 0;
    exports['glGetTexLevelParameteriv'] = (): number => 0;
    exports['glGetTexImage'] = (): number => 0;
    exports['glGetPointerv'] = (): number => 0;
    exports['glAreTexturesResident'] = (): number => GL_TRUE;

    return exports;
}
