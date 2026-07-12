export const enum Legacy3DDirtyBit {
    Blend = 1 << 0,
    Depth = 1 << 1,
    AlphaTest = 1 << 2,
    Texture = 1 << 3,
    Fog = 1 << 4,
    Color = 1 << 5,
    Cull = 1 << 6,
}

export class Legacy3DFFPState {
    private dirtyBits = 0xffffffff;

    blendEnabled = false;
    depthTestEnabled = false;
    depthWriteEnabled = true;
    alphaTestEnabled = false;
    alphaRef = 0;
    fogEnabled = false;
    cullMode = 0;

    textureEnabled = false;
    textureHandle = 0;

    constantColor = 0xffffffff;
    chromaKeyEnabled = false;
    chromaKey = 0;

    setBlend(enabled: boolean): void {
        this.blendEnabled = enabled;
        this.dirtyBits |= Legacy3DDirtyBit.Blend;
    }

    setDepth(testEnabled: boolean, writeEnabled: boolean): void {
        this.depthTestEnabled = testEnabled;
        this.depthWriteEnabled = writeEnabled;
        this.dirtyBits |= Legacy3DDirtyBit.Depth;
    }

    setAlphaTest(enabled: boolean, alphaRef: number): void {
        this.alphaTestEnabled = enabled;
        this.alphaRef = alphaRef >>> 0;
        this.dirtyBits |= Legacy3DDirtyBit.AlphaTest;
    }

    setTexture(enabled: boolean, handle: number): void {
        this.textureEnabled = enabled;
        this.textureHandle = handle | 0;
        this.dirtyBits |= Legacy3DDirtyBit.Texture;
    }

    setFog(enabled: boolean): void {
        this.fogEnabled = enabled;
        this.dirtyBits |= Legacy3DDirtyBit.Fog;
    }

    setConstantColor(color: number): void {
        this.constantColor = color >>> 0;
        this.dirtyBits |= Legacy3DDirtyBit.Color;
    }

    setChromaKey(enabled: boolean, color: number): void {
        this.chromaKeyEnabled = enabled;
        this.chromaKey = color >>> 0;
        this.dirtyBits |= Legacy3DDirtyBit.Color;
    }

    setCullMode(mode: number): void {
        this.cullMode = mode >>> 0;
        this.dirtyBits |= Legacy3DDirtyBit.Cull;
    }

    consumeDirtyBits(): number {
        const bits = this.dirtyBits;
        this.dirtyBits = 0;
        return bits;
    }

    invalidateAll(): void {
        this.dirtyBits = 0xffffffff;
    }

    reset(): void {
        this.blendEnabled = false;
        this.depthTestEnabled = false;
        this.depthWriteEnabled = true;
        this.alphaTestEnabled = false;
        this.alphaRef = 0;
        this.fogEnabled = false;
        this.cullMode = 0;
        this.textureEnabled = false;
        this.textureHandle = 0;
        this.constantColor = 0xffffffff;
        this.chromaKeyEnabled = false;
        this.chromaKey = 0;
        this.dirtyBits = 0xffffffff;
    }
}
