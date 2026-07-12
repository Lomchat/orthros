import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Mem } from "../../core/memory/mem-accessor";
import { OpenGLContext } from "./context";
import { GL_TEXTURE0 } from "./constants";
import { bitsToF32 } from "./immediate";

export function createMultitextureExports(ctx: OpenGLContext): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['glActiveTexture'] = (_c, _m, args): number => {
        const unit = (args[0] >>> 0) - GL_TEXTURE0;
        if (unit >= 0 && unit < ctx.textureUnits.length) ctx.activeTextureUnit = unit;
        return 0;
    };

    exports['glClientActiveTexture'] = (_c, _m, args): number => {
        const unit = (args[0] >>> 0) - GL_TEXTURE0;
        if (unit >= 0 && unit < ctx.texCoordArrays.length) ctx.clientActiveTextureUnit = unit;
        return 0;
    };

    // ARB aliases
    exports['glActiveTextureARB'] = exports['glActiveTexture'];
    exports['glClientActiveTextureARB'] = exports['glClientActiveTexture'];

    // MultiTexCoord variants
    exports['glMultiTexCoord1d'] = (_c, _m, args): number => {
        const unit = (args[0] >>> 0) - GL_TEXTURE0;
        if (unit >= 0 && unit < ctx.currentTexCoord.length) {
            ctx.currentTexCoord[unit][0] = args[1] as number;
            ctx.currentTexCoord[unit][1] = 0;
        }
        return 0;
    };

    exports['glMultiTexCoord2f'] = (_c, _m, args): number => {
        const unit = (args[0] >>> 0) - GL_TEXTURE0;
        if (unit >= 0 && unit < ctx.currentTexCoord.length) {
            ctx.currentTexCoord[unit][0] = bitsToF32(args[1]);
            ctx.currentTexCoord[unit][1] = bitsToF32(args[2]);
        }
        return 0;
    };

    exports['glMultiTexCoord2d'] = (_c, _m, args): number => {
        const unit = (args[0] >>> 0) - GL_TEXTURE0;
        if (unit >= 0 && unit < ctx.currentTexCoord.length) {
            ctx.currentTexCoord[unit][0] = args[1] as number;
            ctx.currentTexCoord[unit][1] = args[2] as number;
        }
        return 0;
    };

    exports['glMultiTexCoord3f'] = (_c, _m, args): number => {
        const unit = (args[0] >>> 0) - GL_TEXTURE0;
        if (unit >= 0 && unit < ctx.currentTexCoord.length) {
            ctx.currentTexCoord[unit][0] = bitsToF32(args[1]);
            ctx.currentTexCoord[unit][1] = bitsToF32(args[2]);
            ctx.currentTexCoord[unit][2] = bitsToF32(args[3]);
        }
        return 0;
    };

    exports['glMultiTexCoord4f'] = (_c, _m, args): number => {
        const unit = (args[0] >>> 0) - GL_TEXTURE0;
        if (unit >= 0 && unit < ctx.currentTexCoord.length) {
            ctx.currentTexCoord[unit][0] = bitsToF32(args[1]);
            ctx.currentTexCoord[unit][1] = bitsToF32(args[2]);
            ctx.currentTexCoord[unit][2] = bitsToF32(args[3]);
            ctx.currentTexCoord[unit][3] = bitsToF32(args[4]);
        }
        return 0;
    };

    // Vector variants
    const readF32Vec = (ptr: number, count: number): number[] => {
        const mem = ctx.process.getCurrentMemory();
        const view = new DataView(mem.buffer, mem.byteOffset);
        const out: number[] = [];
        for (let j = 0; j < count; j++) out.push(view.getFloat32(ptr + j * 4, true));
        return out;
    };

    exports['glMultiTexCoord2fv'] = (_c, _m, args): number => {
        const unit = (args[0] >>> 0) - GL_TEXTURE0;
        if (unit >= 0 && unit < ctx.currentTexCoord.length) {
            const v = readF32Vec(args[1] >>> 0, 2);
            ctx.currentTexCoord[unit][0] = v[0]; ctx.currentTexCoord[unit][1] = v[1];
        }
        return 0;
    };

    exports['glMultiTexCoord4fv'] = (_c, _m, args): number => {
        const unit = (args[0] >>> 0) - GL_TEXTURE0;
        if (unit >= 0 && unit < ctx.currentTexCoord.length) {
            const v = readF32Vec(args[1] >>> 0, 4);
            ctx.currentTexCoord[unit][0] = v[0]; ctx.currentTexCoord[unit][1] = v[1];
            ctx.currentTexCoord[unit][2] = v[2]; ctx.currentTexCoord[unit][3] = v[3];
        }
        return 0;
    };

    // ARB aliases for vector variants
    exports['glMultiTexCoord2fARB'] = exports['glMultiTexCoord2f'];
    exports['glMultiTexCoord2fvARB'] = exports['glMultiTexCoord2fv'];
    exports['glMultiTexCoord4fARB'] = exports['glMultiTexCoord4f'];
    exports['glMultiTexCoord4fvARB'] = exports['glMultiTexCoord4fv'];

    // Remaining MultiTexCoord stubs (d/dv/i/iv/s/sv variants)
    const stubMultiTex = (): number => 0;
    exports['glMultiTexCoord1dv'] = stubMultiTex;
    exports['glMultiTexCoord1f'] = (_c, _m, args): number => {
        const unit = (args[0] >>> 0) - GL_TEXTURE0;
        if (unit >= 0 && unit < ctx.currentTexCoord.length) {
            ctx.currentTexCoord[unit][0] = bitsToF32(args[1]);
        }
        return 0;
    };
    exports['glMultiTexCoord1fv'] = stubMultiTex;
    exports['glMultiTexCoord1i'] = stubMultiTex;
    exports['glMultiTexCoord1iv'] = stubMultiTex;
    exports['glMultiTexCoord1s'] = stubMultiTex;
    exports['glMultiTexCoord1sv'] = stubMultiTex;
    exports['glMultiTexCoord2dv'] = stubMultiTex;
    exports['glMultiTexCoord2i'] = stubMultiTex;
    exports['glMultiTexCoord2iv'] = stubMultiTex;
    exports['glMultiTexCoord2s'] = stubMultiTex;
    exports['glMultiTexCoord2sv'] = stubMultiTex;
    exports['glMultiTexCoord3d'] = stubMultiTex;
    exports['glMultiTexCoord3dv'] = stubMultiTex;
    exports['glMultiTexCoord3fv'] = stubMultiTex;
    exports['glMultiTexCoord3i'] = stubMultiTex;
    exports['glMultiTexCoord3iv'] = stubMultiTex;
    exports['glMultiTexCoord3s'] = stubMultiTex;
    exports['glMultiTexCoord3sv'] = stubMultiTex;
    exports['glMultiTexCoord4d'] = stubMultiTex;
    exports['glMultiTexCoord4dv'] = stubMultiTex;
    exports['glMultiTexCoord4i'] = stubMultiTex;
    exports['glMultiTexCoord4iv'] = stubMultiTex;
    exports['glMultiTexCoord4s'] = stubMultiTex;
    exports['glMultiTexCoord4sv'] = stubMultiTex;

    return exports;
}
