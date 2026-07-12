import { GLCommand, GLTextureObject } from "../../../modules/opengl32/context";

export interface OpenGLFrameInput {
    commands: GLCommand[];
    textures: Map<number, GLTextureObject>;
    viewportX: number;
    viewportY: number;
    viewportW: number;
    viewportH: number;
}
