import {
    Legacy3DCommandType,
    Legacy3DClearCommand,
    Legacy3DDrawCommand,
    LegacyPrimitiveTopology,
} from "./types";

const TOPOLOGY_TO_ID: Record<LegacyPrimitiveTopology, number> = {
    "point-list": 1,
    "line-list": 2,
    "triangle-list": 3,
};

const ID_TO_TOPOLOGY: Record<number, LegacyPrimitiveTopology> = {
    1: "point-list",
    2: "line-list",
    3: "triangle-list",
};

export class Legacy3DCommandStream {
    readonly commandTypes: number[] = [];
    readonly commandA: number[] = [];
    readonly commandB: number[] = [];
    readonly commandC: number[] = [];
    readonly commandD: number[] = [];
    readonly commandE: number[] = [];
    readonly commandF: number[] = [];
    readonly commandG: number[] = [];
    readonly commandH: number[] = [];
    readonly commandI: number[] = [];
    readonly commandJ: number[] = [];
    readonly commandK: number[] = [];
    readonly commandL: number[] = [];
    readonly commandM: number[] = [];

    readonly vertexX: number[] = [];
    readonly vertexY: number[] = [];
    readonly vertexZ: number[] = [];
    readonly vertexU: number[] = [];
    readonly vertexV: number[] = [];
    readonly vertexQ: number[] = [];
    readonly vertexColor: number[] = [];

    reset(): void {
        this.commandTypes.length = 0;
        this.commandA.length = 0;
        this.commandB.length = 0;
        this.commandC.length = 0;
        this.commandD.length = 0;
        this.commandE.length = 0;
        this.commandF.length = 0;
        this.commandG.length = 0;
        this.commandH.length = 0;
        this.commandI.length = 0;
        this.commandJ.length = 0;
        this.commandK.length = 0;
        this.commandL.length = 0;
        this.commandM.length = 0;

        this.vertexX.length = 0;
        this.vertexY.length = 0;
        this.vertexZ.length = 0;
        this.vertexU.length = 0;
        this.vertexV.length = 0;
        this.vertexQ.length = 0;
        this.vertexColor.length = 0;
    }

    hasCommands(): boolean {
        return this.commandTypes.length > 0;
    }

    getVertexCount(): number {
        return this.vertexX.length;
    }

    pushVertex(x: number, y: number, z: number, u: number, v: number, q: number, color: number): number {
        const idx = this.vertexX.length;
        this.vertexX.push(x);
        this.vertexY.push(y);
        this.vertexZ.push(z);
        this.vertexU.push(u);
        this.vertexV.push(v);
        this.vertexQ.push(q);
        this.vertexColor.push(color >>> 0);
        return idx;
    }

    pushClear(command: Legacy3DClearCommand): void {
        this.commandTypes.push(Legacy3DCommandType.Clear);
        this.commandA.push(command.color >>> 0);
        this.commandB.push(command.depth >>> 0);
        this.commandC.push(command.clearColor ? 1 : 0);
        this.commandD.push(command.clearDepth ? 1 : 0);
        this.commandE.push(0);
        this.commandF.push(0);
        this.commandG.push(0);
        this.commandH.push(0);
        this.commandI.push(0);
        this.commandJ.push(0);
        this.commandK.push(0);
        this.commandL.push(0);
        this.commandM.push(0);
    }

    pushDraw(command: Legacy3DDrawCommand): void {
        const flags =
            (command.useTexture ? 1 : 0) |
            (command.blendEnabled ? 1 << 1 : 0) |
            (command.depthTestEnabled ? 1 << 2 : 0) |
            (command.depthWriteEnabled ? 1 << 3 : 0) |
            (command.alphaTestEnabled ? 1 << 4 : 0) |
            (command.clampS ? 1 << 5 : 0) |
            (command.clampT ? 1 << 6 : 0) |
            (command.filterLinear ? 1 << 7 : 0) |
            ((command.depthFunction & 0x7) << 8) |
            (command.colorMaskRgb ? 1 << 11 : 0) |
            (command.colorMaskAlpha ? 1 << 12 : 0);

        this.commandTypes.push(Legacy3DCommandType.Draw);
        this.commandA.push(command.firstVertex | 0);
        this.commandB.push(command.vertexCount | 0);
        this.commandC.push(TOPOLOGY_TO_ID[command.topology] ?? TOPOLOGY_TO_ID["triangle-list"]);
        this.commandD.push(command.textureHandle | 0);
        this.commandE.push(flags);
        this.commandF.push(command.alphaRef >>> 0);
        this.commandG.push(command.cullMode >>> 0);
        this.commandH.push(command.constantColor >>> 0);
        this.commandI.push(command.colorCombine >>> 0);
        this.commandJ.push(command.alphaCombine >>> 0);
        this.commandK.push(command.blend >>> 0);
        this.commandL.push(command.fogColor >>> 0);
        this.commandM.push(((command.fogMode & 0xffff) | ((command.alphaTestFunc & 0x7) << 16)) >>> 0);
    }

    getClearCommand(index: number): Legacy3DClearCommand | null {
        if (this.commandTypes[index] !== Legacy3DCommandType.Clear) {
            return null;
        }
        return {
            color: this.commandA[index] >>> 0,
            depth: this.commandB[index] >>> 0,
            clearColor: this.commandC[index] !== 0,
            clearDepth: this.commandD[index] !== 0,
        };
    }

    getDrawCommand(index: number): Legacy3DDrawCommand | null {
        if (this.commandTypes[index] !== Legacy3DCommandType.Draw) {
            return null;
        }

        const flags = this.commandE[index] >>> 0;
        const fogPacked = this.commandM[index] >>> 0;
        return {
            firstVertex: this.commandA[index] | 0,
            vertexCount: this.commandB[index] | 0,
            topology: ID_TO_TOPOLOGY[this.commandC[index] | 0] ?? "triangle-list",
            textureHandle: this.commandD[index] | 0,
            useTexture: (flags & 1) !== 0,
            blendEnabled: (flags & (1 << 1)) !== 0,
            depthTestEnabled: (flags & (1 << 2)) !== 0,
            depthWriteEnabled: (flags & (1 << 3)) !== 0,
            depthFunction: (flags >>> 8) & 0x7,
            alphaTestEnabled: (flags & (1 << 4)) !== 0,
            alphaRef: this.commandF[index] >>> 0,
            cullMode: this.commandG[index] >>> 0,
            constantColor: this.commandH[index] >>> 0,
            clampS: (flags & (1 << 5)) !== 0,
            clampT: (flags & (1 << 6)) !== 0,
            filterLinear: (flags & (1 << 7)) !== 0,
            colorMaskRgb: (flags & (1 << 11)) !== 0,
            colorMaskAlpha: (flags & (1 << 12)) !== 0,
            colorCombine: this.commandI[index] >>> 0,
            alphaCombine: this.commandJ[index] >>> 0,
            blend: this.commandK[index] >>> 0,
            fogColor: this.commandL[index] >>> 0,
            fogMode: fogPacked & 0xffff,
            alphaTestFunc: (fogPacked >>> 16) & 0x7,
        };
    }
}
