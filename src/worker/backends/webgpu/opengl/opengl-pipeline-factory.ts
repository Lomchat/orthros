/**
 * OpenGL FFP → WebGPU pipeline factory
 * Generates WGSL shaders for fixed-function combos and caches pipelines.
 */

export interface OpenGLPipelineConfig {
    topology: "triangle-list" | "line-list" | "line-strip" | "point-list";
    blendEnabled: boolean;
    blendSrc: number;
    blendDst: number;
    depthTest: boolean;
    depthWrite: boolean;
    depthFunc: number;
    cullEnabled: boolean;
    cullFace: number;
    frontFace: number;
    colorMaskR: boolean;
    colorMaskG: boolean;
    colorMaskB: boolean;
    colorMaskA: boolean;
    stencilTest: boolean;
    stencilFunc: number;
    stencilMask: number;
    stencilWriteMask: number;
    stencilFail: number;
    stencilZFail: number;
    stencilZPass: number;
}

export function pipelineConfigKey(cfg: OpenGLPipelineConfig): string {
    return `${cfg.topology}|${+cfg.blendEnabled}|${cfg.blendSrc}|${cfg.blendDst}|${+cfg.depthTest}|${+cfg.depthWrite}|${cfg.depthFunc}|${+cfg.cullEnabled}|${cfg.cullFace}|${cfg.frontFace}|${+cfg.colorMaskR}|${+cfg.colorMaskG}|${+cfg.colorMaskB}|${+cfg.colorMaskA}|${+cfg.stencilTest}|${cfg.stencilFunc}|${cfg.stencilMask}|${cfg.stencilWriteMask}|${cfg.stencilFail}|${cfg.stencilZFail}|${cfg.stencilZPass}`;
}
