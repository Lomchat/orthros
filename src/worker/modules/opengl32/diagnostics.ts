import { OpenGLContext, GLFrameSnapshot } from "./context";

export interface OpenGLDebugInfo {
    state: {
        initialized: boolean;
        contextCount: number;
        activeTextureUnit: number;
        matrixMode: number;
        viewportW: number;
        viewportH: number;
    };
    textures: number;
    displayLists: number;
    frameSnapshot: GLFrameSnapshot;
}

export function buildOpenGLDebugInfo(ctx: OpenGLContext): OpenGLDebugInfo {
    return {
        state: {
            initialized: true,
            contextCount: 1,
            activeTextureUnit: ctx.activeTextureUnit,
            matrixMode: ctx.matrixMode,
            viewportW: ctx.viewportW,
            viewportH: ctx.viewportH,
        },
        textures: ctx.textures.size,
        displayLists: ctx.displayLists.size,
        frameSnapshot: { ...ctx.frameSnapshot },
    };
}

export function cloneFrameSnapshot(snap: GLFrameSnapshot): GLFrameSnapshot {
    return { ...snap };
}
