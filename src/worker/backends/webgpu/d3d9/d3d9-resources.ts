/**
 * Data-Oriented Resource Stores for D3D9
 *
 * Structure-of-Arrays (SoA) layout for cache-efficient access patterns.
 * Each store manages one resource type with generation counters for safety.
 */

import {
    getD3DTextureLayout,
} from "../shared/texture-formats";


// Vertex Buffer Store - SoA layout
export class VertexBufferStore {
    // Capacity management
    private capacity: number;
    private count = 0;
    private freeList: number[] = [];

    // SoA arrays
    private sizes: Uint32Array;
    private fvfs: Uint32Array;
    private data: (Uint8Array | undefined)[];
    private gpuBuffers: (GPUBuffer | null)[];
    private lockedPtrs: Int32Array;    // -1 = not locked
    private lockedSizes: Uint32Array;
    private lockedOffsets: Uint32Array;
    private guestPtrs: Int32Array;     // HEAP backing for Lock/Unlock
    private dirtyFlags: Uint8Array;    // Boolean as byte
    /** Half-open byte range dirtied since the previous upload. */
    private dirtyStarts: Uint32Array;
    private dirtyEnds: Uint32Array;
    private generations: Uint16Array;

    // Handle mapping
    private handleToIndex: Map<number, number> = new Map();

    constructor(initialCapacity = 256) {
        this.capacity = initialCapacity;
        this.sizes = new Uint32Array(initialCapacity);
        this.fvfs = new Uint32Array(initialCapacity);
        this.data = new Array(initialCapacity);
        this.gpuBuffers = new Array(initialCapacity).fill(null);
        this.lockedPtrs = new Int32Array(initialCapacity).fill(-1);
        this.lockedSizes = new Uint32Array(initialCapacity);
        this.lockedOffsets = new Uint32Array(initialCapacity);
        this.guestPtrs = new Int32Array(initialCapacity).fill(-1);
        this.dirtyFlags = new Uint8Array(initialCapacity);
        this.dirtyStarts = new Uint32Array(initialCapacity);
        this.dirtyEnds = new Uint32Array(initialCapacity);
        this.generations = new Uint16Array(initialCapacity);
    }

    create(handle: number, size: number, fvf: number, guestPtr: number): number {
        let index: number;
        if (this.freeList.length > 0) {
            index = this.freeList.pop()!;
        } else {
            if (this.count >= this.capacity) {
                this.grow();
            }
            index = this.count++;
        }

        this.sizes[index] = size;
        this.fvfs[index] = fvf;
        this.data[index] = new Uint8Array(size);
        this.gpuBuffers[index] = null;
        this.lockedPtrs[index] = -1;
        this.lockedSizes[index] = 0;
        this.lockedOffsets[index] = 0;
        this.guestPtrs[index] = guestPtr;
        this.dirtyFlags[index] = 1;
        this.dirtyStarts[index] = 0;
        this.dirtyEnds[index] = size;

        const gen = this.generations[index];
        const packed = (gen << 16) | index;
        this.handleToIndex.set(handle, packed);
        return index;
    }

    getIndex(handle: number): number | null {
        const packed = this.handleToIndex.get(handle);
        if (packed === undefined) return null;
        const index = packed & 0xFFFF;
        const expectedGen = (packed >> 16) & 0xFFFF;
        if (this.generations[index] !== expectedGen) {
            this.handleToIndex.delete(handle);
            return null;
        }
        return index;
    }

    release(handle: number): { gpuBuffer: GPUBuffer | null; guestPtr: number } | null {
        const packed = this.handleToIndex.get(handle);
        if (packed === undefined) return null;
        const index = packed & 0xFFFF;
        const expectedGen = (packed >> 16) & 0xFFFF;
        if (this.generations[index] !== expectedGen) {
            this.handleToIndex.delete(handle);
            return null;
        }

        const gpuBuffer = this.gpuBuffers[index];
        const guestPtr = this.guestPtrs[index];
        this.data[index] = undefined;
        this.gpuBuffers[index] = null;
        this.guestPtrs[index] = -1;
        this.dirtyFlags[index] = 0;
        this.dirtyStarts[index] = 0;
        this.dirtyEnds[index] = 0;
        this.generations[index] = (this.generations[index] + 1) & 0xFFFF;
        this.freeList.push(index);
        this.handleToIndex.delete(handle);

        return { gpuBuffer, guestPtr };
    }

    // Getters for individual fields
    getSize(index: number): number { return this.sizes[index]; }
    getFvf(index: number): number { return this.fvfs[index]; }
    getData(index: number): Uint8Array | undefined { return this.data[index]; }
    getGpuBuffer(index: number): GPUBuffer | null { return this.gpuBuffers[index]; }
    getGuestPtr(index: number): number { return this.guestPtrs[index]; }
    isDirty(index: number): boolean { return this.dirtyFlags[index] !== 0; }
    getDirtyStart(index: number): number { return this.dirtyStarts[index]; }
    getDirtyEnd(index: number): number { return this.dirtyEnds[index]; }
    isLocked(index: number): boolean { return this.lockedPtrs[index] !== -1; }

    // Setters
    setGpuBuffer(index: number, buffer: GPUBuffer): void { this.gpuBuffers[index] = buffer; }
    setDirty(index: number, dirty: boolean): void {
        this.dirtyFlags[index] = dirty ? 1 : 0;
        this.dirtyStarts[index] = 0;
        this.dirtyEnds[index] = dirty ? this.sizes[index] : 0;
    }

    // Lock operations — returns guest pointer for the locked region
    lock(index: number, offset: number, size: number): number {
        const guestBase = this.guestPtrs[index];
        if (guestBase < 0) return -1;
        this.lockedPtrs[index] = guestBase + offset;
        this.lockedSizes[index] = size;
        this.lockedOffsets[index] = offset;
        return guestBase + offset;
    }

    unlock(index: number, memory: Uint8Array): void {
        const guestBase = this.guestPtrs[index];
        if (guestBase < 0 || this.lockedPtrs[index] === -1) return;
        const size = this.lockedSizes[index];
        const offset = this.lockedOffsets[index];
        const data = this.data[index];
        if (data) {
            data.set(memory.subarray(guestBase + offset, guestBase + offset + size), offset);
        }
        this.lockedPtrs[index] = -1;
        this.lockedSizes[index] = 0;
        this.lockedOffsets[index] = 0;
        if (this.dirtyFlags[index]) {
            this.dirtyStarts[index] = Math.min(this.dirtyStarts[index], offset);
            this.dirtyEnds[index] = Math.max(this.dirtyEnds[index], offset + size);
        } else {
            this.dirtyFlags[index] = 1;
            this.dirtyStarts[index] = offset;
            this.dirtyEnds[index] = offset + size;
        }
    }

    // Batch upload all dirty buffers
    uploadDirty(device: GPUDevice, queue: GPUQueue): number {
        let uploaded = 0;
        for (let i = 0; i < this.count; i++) {
            if (this.dirtyFlags[i] && this.data[i]) {
                if (!this.gpuBuffers[i]) {
                    this.gpuBuffers[i] = device.createBuffer({
                        size: this.sizes[i],
                        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
                    });
                }
                queue.writeBuffer(this.gpuBuffers[i]!, 0, this.data[i]!);
                this.setDirty(i, false);
                uploaded++;
            }
        }
        return uploaded;
    }

    private grow(): void {
        const newCapacity = this.capacity * 2;

        const newSizes = new Uint32Array(newCapacity);
        newSizes.set(this.sizes);
        this.sizes = newSizes;

        const newFvfs = new Uint32Array(newCapacity);
        newFvfs.set(this.fvfs);
        this.fvfs = newFvfs;

        const newData = new Array(newCapacity);
        for (let i = 0; i < this.data.length; i++) newData[i] = this.data[i];
        this.data = newData;

        const newGpuBuffers = new Array(newCapacity).fill(null);
        for (let i = 0; i < this.gpuBuffers.length; i++) newGpuBuffers[i] = this.gpuBuffers[i];
        this.gpuBuffers = newGpuBuffers;

        const newLockedPtrs = new Int32Array(newCapacity).fill(-1);
        newLockedPtrs.set(this.lockedPtrs);
        this.lockedPtrs = newLockedPtrs;

        const newLockedSizes = new Uint32Array(newCapacity);
        newLockedSizes.set(this.lockedSizes);
        this.lockedSizes = newLockedSizes;

        const newLockedOffsets = new Uint32Array(newCapacity);
        newLockedOffsets.set(this.lockedOffsets);
        this.lockedOffsets = newLockedOffsets;

        const newGuestPtrs = new Int32Array(newCapacity).fill(-1);
        newGuestPtrs.set(this.guestPtrs);
        this.guestPtrs = newGuestPtrs;

        const newDirtyFlags = new Uint8Array(newCapacity);
        newDirtyFlags.set(this.dirtyFlags);
        this.dirtyFlags = newDirtyFlags;

        const newDirtyStarts = new Uint32Array(newCapacity);
        newDirtyStarts.set(this.dirtyStarts);
        this.dirtyStarts = newDirtyStarts;

        const newDirtyEnds = new Uint32Array(newCapacity);
        newDirtyEnds.set(this.dirtyEnds);
        this.dirtyEnds = newDirtyEnds;

        const newGenerations = new Uint16Array(newCapacity);
        newGenerations.set(this.generations);
        this.generations = newGenerations;

        this.capacity = newCapacity;
    }

    // Debug export: get all vertex buffers info
    getAllDebugInfo(): Array<{
        index: number;
        handle: number;
        size: number;
        fvf: number;
        isDirty: boolean;
        isLocked: boolean;
        hasGpuBuffer: boolean;
    }> {
        const result: Array<{
            index: number;
            handle: number;
            size: number;
            fvf: number;
            isDirty: boolean;
            isLocked: boolean;
            hasGpuBuffer: boolean;
        }> = [];
        
        for (const [handle, packed] of this.handleToIndex.entries()) {
            const index = packed & 0xFFFF;
            const expectedGen = (packed >> 16) & 0xFFFF;
            if (this.generations[index] !== expectedGen) continue;
            if (this.data[index] === undefined) continue;
            
            result.push({
                index,
                handle,
                size: this.sizes[index],
                fvf: this.fvfs[index],
                isDirty: this.dirtyFlags[index] !== 0,
                isLocked: this.lockedPtrs[index] !== -1,
                hasGpuBuffer: this.gpuBuffers[index] !== null,
            });
        }
        
        return result;
    }
}

// Index Buffer Store - SoA layout
export class IndexBufferStore {
    private capacity: number;
    private count = 0;
    private freeList: number[] = [];

    private sizes: Uint32Array;
    private formats: Uint32Array;
    private data: (Uint8Array | undefined)[];
    private gpuBuffers: (GPUBuffer | null)[];
    private lockedPtrs: Int32Array;
    private lockedSizes: Uint32Array;
    private lockedOffsets: Uint32Array;
    private guestPtrs: Int32Array;
    private dirtyFlags: Uint8Array;
    private dirtyStarts: Uint32Array;
    private dirtyEnds: Uint32Array;
    private generations: Uint16Array;

    private handleToIndex: Map<number, number> = new Map();

    constructor(initialCapacity = 256) {
        this.capacity = initialCapacity;
        this.sizes = new Uint32Array(initialCapacity);
        this.formats = new Uint32Array(initialCapacity);
        this.data = new Array(initialCapacity);
        this.gpuBuffers = new Array(initialCapacity).fill(null);
        this.lockedPtrs = new Int32Array(initialCapacity).fill(-1);
        this.lockedSizes = new Uint32Array(initialCapacity);
        this.lockedOffsets = new Uint32Array(initialCapacity);
        this.guestPtrs = new Int32Array(initialCapacity).fill(-1);
        this.dirtyFlags = new Uint8Array(initialCapacity);
        this.dirtyStarts = new Uint32Array(initialCapacity);
        this.dirtyEnds = new Uint32Array(initialCapacity);
        this.generations = new Uint16Array(initialCapacity);
    }

    create(handle: number, size: number, format: number, guestPtr: number): number {
        let index: number;
        if (this.freeList.length > 0) {
            index = this.freeList.pop()!;
        } else {
            if (this.count >= this.capacity) {
                this.grow();
            }
            index = this.count++;
        }

        this.sizes[index] = size;
        this.formats[index] = format;
        this.data[index] = new Uint8Array(size);
        this.gpuBuffers[index] = null;
        this.lockedPtrs[index] = -1;
        this.lockedSizes[index] = 0;
        this.lockedOffsets[index] = 0;
        this.guestPtrs[index] = guestPtr;
        this.dirtyFlags[index] = 1;
        this.dirtyStarts[index] = 0;
        this.dirtyEnds[index] = size;

        const gen = this.generations[index];
        const packed = (gen << 16) | index;
        this.handleToIndex.set(handle, packed);
        return index;
    }

    getIndex(handle: number): number | null {
        const packed = this.handleToIndex.get(handle);
        if (packed === undefined) return null;
        const index = packed & 0xFFFF;
        const expectedGen = (packed >> 16) & 0xFFFF;
        if (this.generations[index] !== expectedGen) {
            this.handleToIndex.delete(handle);
            return null;
        }
        return index;
    }

    release(handle: number): { gpuBuffer: GPUBuffer | null; guestPtr: number } | null {
        const packed = this.handleToIndex.get(handle);
        if (packed === undefined) return null;
        const index = packed & 0xFFFF;
        const expectedGen = (packed >> 16) & 0xFFFF;
        if (this.generations[index] !== expectedGen) {
            this.handleToIndex.delete(handle);
            return null;
        }

        const gpuBuffer = this.gpuBuffers[index];
        const guestPtr = this.guestPtrs[index];
        this.data[index] = undefined;
        this.gpuBuffers[index] = null;
        this.guestPtrs[index] = -1;
        this.dirtyFlags[index] = 0;
        this.dirtyStarts[index] = 0;
        this.dirtyEnds[index] = 0;
        this.generations[index] = (this.generations[index] + 1) & 0xFFFF;
        this.freeList.push(index);
        this.handleToIndex.delete(handle);

        return { gpuBuffer, guestPtr };
    }

    getSize(index: number): number { return this.sizes[index]; }
    getFormat(index: number): number { return this.formats[index]; }
    getData(index: number): Uint8Array | undefined { return this.data[index]; }
    getGpuBuffer(index: number): GPUBuffer | null { return this.gpuBuffers[index]; }
    getGuestPtr(index: number): number { return this.guestPtrs[index]; }
    isDirty(index: number): boolean { return this.dirtyFlags[index] !== 0; }
    getDirtyStart(index: number): number { return this.dirtyStarts[index]; }
    getDirtyEnd(index: number): number { return this.dirtyEnds[index]; }

    setGpuBuffer(index: number, buffer: GPUBuffer): void { this.gpuBuffers[index] = buffer; }
    setDirty(index: number, dirty: boolean): void {
        this.dirtyFlags[index] = dirty ? 1 : 0;
        this.dirtyStarts[index] = 0;
        this.dirtyEnds[index] = dirty ? this.sizes[index] : 0;
    }

    lock(index: number, offset: number, size: number): number {
        const guestBase = this.guestPtrs[index];
        if (guestBase < 0) return -1;
        this.lockedPtrs[index] = guestBase + offset;
        this.lockedSizes[index] = size;
        this.lockedOffsets[index] = offset;
        return guestBase + offset;
    }

    unlock(index: number, memory: Uint8Array): void {
        const guestBase = this.guestPtrs[index];
        if (guestBase < 0 || this.lockedPtrs[index] === -1) return;
        const size = this.lockedSizes[index];
        const offset = this.lockedOffsets[index];
        const data = this.data[index];
        if (data) {
            data.set(memory.subarray(guestBase + offset, guestBase + offset + size), offset);
        }
        this.lockedPtrs[index] = -1;
        this.lockedSizes[index] = 0;
        this.lockedOffsets[index] = 0;
        if (this.dirtyFlags[index]) {
            this.dirtyStarts[index] = Math.min(this.dirtyStarts[index], offset);
            this.dirtyEnds[index] = Math.max(this.dirtyEnds[index], offset + size);
        } else {
            this.dirtyFlags[index] = 1;
            this.dirtyStarts[index] = offset;
            this.dirtyEnds[index] = offset + size;
        }
    }

    uploadDirty(device: GPUDevice, queue: GPUQueue): number {
        let uploaded = 0;
        for (let i = 0; i < this.count; i++) {
            if (this.dirtyFlags[i] && this.data[i]) {
                if (!this.gpuBuffers[i]) {
                    this.gpuBuffers[i] = device.createBuffer({
                        size: this.sizes[i],
                        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
                    });
                }
                queue.writeBuffer(this.gpuBuffers[i]!, 0, this.data[i]!);
                this.setDirty(i, false);
                uploaded++;
            }
        }
        return uploaded;
    }

    private grow(): void {
        const newCapacity = this.capacity * 2;

        const newSizes = new Uint32Array(newCapacity);
        newSizes.set(this.sizes);
        this.sizes = newSizes;

        const newFormats = new Uint32Array(newCapacity);
        newFormats.set(this.formats);
        this.formats = newFormats;

        const newData = new Array(newCapacity);
        for (let i = 0; i < this.data.length; i++) newData[i] = this.data[i];
        this.data = newData;

        const newGpuBuffers = new Array(newCapacity).fill(null);
        for (let i = 0; i < this.gpuBuffers.length; i++) newGpuBuffers[i] = this.gpuBuffers[i];
        this.gpuBuffers = newGpuBuffers;

        const newLockedPtrs = new Int32Array(newCapacity).fill(-1);
        newLockedPtrs.set(this.lockedPtrs);
        this.lockedPtrs = newLockedPtrs;

        const newLockedSizes = new Uint32Array(newCapacity);
        newLockedSizes.set(this.lockedSizes);
        this.lockedSizes = newLockedSizes;

        const newLockedOffsets = new Uint32Array(newCapacity);
        newLockedOffsets.set(this.lockedOffsets);
        this.lockedOffsets = newLockedOffsets;

        const newGuestPtrs = new Int32Array(newCapacity).fill(-1);
        newGuestPtrs.set(this.guestPtrs);
        this.guestPtrs = newGuestPtrs;

        const newDirtyFlags = new Uint8Array(newCapacity);
        newDirtyFlags.set(this.dirtyFlags);
        this.dirtyFlags = newDirtyFlags;

        const newDirtyStarts = new Uint32Array(newCapacity);
        newDirtyStarts.set(this.dirtyStarts);
        this.dirtyStarts = newDirtyStarts;

        const newDirtyEnds = new Uint32Array(newCapacity);
        newDirtyEnds.set(this.dirtyEnds);
        this.dirtyEnds = newDirtyEnds;

        const newGenerations = new Uint16Array(newCapacity);
        newGenerations.set(this.generations);
        this.generations = newGenerations;

        this.capacity = newCapacity;
    }

    // Debug export: get all index buffers info
    getAllDebugInfo(): Array<{
        handle: number;
        size: number;
        format: number;
        isDirty: boolean;
        isLocked: boolean;
        hasGpuBuffer: boolean;
    }> {
        const result: Array<{
            handle: number;
            size: number;
            format: number;
            isDirty: boolean;
            isLocked: boolean;
            hasGpuBuffer: boolean;
        }> = [];
        
        for (const [handle, packed] of this.handleToIndex.entries()) {
            const index = packed & 0xFFFF;
            const expectedGen = (packed >> 16) & 0xFFFF;
            if (this.generations[index] !== expectedGen) continue;
            if (this.data[index] === undefined) continue;
            
            result.push({
                handle,
                size: this.sizes[index],
                format: this.formats[index],
                isDirty: this.dirtyFlags[index] !== 0,
                isLocked: this.lockedPtrs[index] !== -1,
                hasGpuBuffer: this.gpuBuffers[index] !== null,
            });
        }
        
        return result;
    }
}

// Texture Store - SoA layout
export class TextureStore {
    private capacity: number;
    private count = 0;
    private freeList: number[] = [];

    private widths: Uint32Array;
    private heights: Uint32Array;
    private levels: Uint32Array;
    // Reverse map (index → handle/texPtr) so upload paths that only hold an index can find the
    // device-side mip data, which is keyed by texPtr. Overwritten on every create() of an index.
    private handles: number[] = [];
    private formats: Uint32Array;
    private data: (Uint8Array | undefined)[];
    private gpuTextures: (GPUTexture | null)[];
    private views: (GPUTextureView | null)[];
    private lockedPtrs: Int32Array;
    private guestPtrs: Int32Array;
    private pitches: Uint32Array;
    private dirtyFlags: Uint8Array;
    private generations: Uint16Array;
    // 1 = render-target texture (rendered into, no guest pixel upload). See markRenderTarget.
    private rtFlags: Uint8Array;
    // 1 = cube texture (6 array layers; sampling view is dimension:"cube"). See markCube.
    private cubeFlags: Uint8Array;

    private handleToIndex: Map<number, number> = new Map();

    constructor(initialCapacity = 256) {
        this.capacity = initialCapacity;
        this.widths = new Uint32Array(initialCapacity);
        this.heights = new Uint32Array(initialCapacity);
        this.levels = new Uint32Array(initialCapacity);
        this.formats = new Uint32Array(initialCapacity);
        this.data = new Array(initialCapacity);
        this.gpuTextures = new Array(initialCapacity).fill(null);
        this.views = new Array(initialCapacity).fill(null);
        this.lockedPtrs = new Int32Array(initialCapacity).fill(-1);
        this.guestPtrs = new Int32Array(initialCapacity).fill(-1);
        this.pitches = new Uint32Array(initialCapacity);
        this.dirtyFlags = new Uint8Array(initialCapacity);
        this.generations = new Uint16Array(initialCapacity);
        this.rtFlags = new Uint8Array(initialCapacity);
        this.cubeFlags = new Uint8Array(initialCapacity);
    }

    create(handle: number, width: number, height: number, levels: number, format: number, guestPtr: number): number {
        let index: number;
        if (this.freeList.length > 0) {
            index = this.freeList.pop()!;
        } else {
            if (this.count >= this.capacity) {
                this.grow();
            }
            index = this.count++;
        }

        // Pitch = block-row stride for compressed (DXT/BC) formats, width*4 for
        // plain ARGB. This is the faithful D3D9 LockRect pitch AND the stride
        // ensureDxtTexture reads the blocks back at. Using width*4 for DXT1
        // (real pitch = width*2) read every other block row → top-half squish.
        this.widths[index] = width;
        this.heights[index] = height;
        this.levels[index] = levels;
        this.handles[index] = handle;
        this.formats[index] = format;
        const layout = getD3DTextureLayout(format, width, height);
        this.data[index] = new Uint8Array(layout.bytes);
        this.gpuTextures[index] = null;
        this.views[index] = null;
        this.lockedPtrs[index] = -1;
        this.guestPtrs[index] = guestPtr;
        this.pitches[index] = layout.pitch;
        this.dirtyFlags[index] = 1;
        this.rtFlags[index] = 0;
        this.cubeFlags[index] = 0;

        const gen = this.generations[index];
        const packed = (gen << 16) | index;
        this.handleToIndex.set(handle, packed);
        return index;
    }

    getIndex(handle: number): number | null {
        const packed = this.handleToIndex.get(handle);
        if (packed === undefined) return null;
        const index = packed & 0xFFFF;
        const expectedGen = (packed >> 16) & 0xFFFF;
        if (this.generations[index] !== expectedGen) {
            this.handleToIndex.delete(handle);
            return null;
        }
        return index;
    }

    release(handle: number): { gpuTexture: GPUTexture | null; guestPtr: number } | null {
        const packed = this.handleToIndex.get(handle);
        if (packed === undefined) return null;
        const index = packed & 0xFFFF;
        const expectedGen = (packed >> 16) & 0xFFFF;
        if (this.generations[index] !== expectedGen) {
            this.handleToIndex.delete(handle);
            return null;
        }

        const gpuTexture = this.gpuTextures[index];
        const guestPtr = this.guestPtrs[index];
        this.data[index] = undefined;
        this.gpuTextures[index] = null;
        this.views[index] = null;
        this.guestPtrs[index] = -1;
        this.generations[index] = (this.generations[index] + 1) & 0xFFFF;
        this.freeList.push(index);
        this.handleToIndex.delete(handle);

        return { gpuTexture, guestPtr };
    }

    getWidth(index: number): number { return this.widths[index]; }
    getHeight(index: number): number { return this.heights[index]; }
    getLevels(index: number): number { return this.levels[index]; }
    getHandle(index: number): number { return this.handles[index]; }
    getFormat(index: number): number { return this.formats[index]; }
    getData(index: number): Uint8Array | undefined { return this.data[index]; }
    getGpuTexture(index: number): GPUTexture | null { return this.gpuTextures[index]; }
    getView(index: number): GPUTextureView | null { return this.views[index]; }
    getPitch(index: number): number { return this.pitches[index]; }
    getGuestPtr(index: number): number { return this.guestPtrs[index]; }
    isDirty(index: number): boolean { return this.dirtyFlags[index] !== 0; }
    isLocked(index: number): boolean { return this.lockedPtrs[index] !== -1; }
    getLockedPtr(index: number): number { return this.lockedPtrs[index]; }

    setGpuTexture(index: number, texture: GPUTexture, view: GPUTextureView): void {
        this.gpuTextures[index] = texture;
        this.views[index] = view;
    }
    setDirty(index: number, dirty: boolean): void { this.dirtyFlags[index] = dirty ? 1 : 0; }

    /**
     * Attach short-lived guest-visible storage for LockRect. Texture pixels live
     * authoritatively in the host-side `data` array between locks; retaining a
     * full second copy in the fixed guest HEAP for every managed texture exhausts
     * the address space in texture-heavy games. The returned pointer remains
     * valid until the matching unlock detaches it.
     */
    attachGuestBacking(index: number, guestPtr: number, memory: Uint8Array): { ptr: number; pitch: number } | null {
        if (guestPtr <= 0 || this.data[index] === undefined || this.guestPtrs[index] >= 0) return null;
        const data = this.data[index]!;
        if (guestPtr + data.length > memory.length) return null;
        memory.set(data, guestPtr);
        this.guestPtrs[index] = guestPtr;
        return this.lock(index);
    }

    /** Detach and return the transient LockRect allocation, or -1 if absent. */
    detachGuestBacking(index: number): number {
        const guestPtr = this.guestPtrs[index];
        this.guestPtrs[index] = -1;
        this.lockedPtrs[index] = -1;
        return guestPtr;
    }
    markRenderTarget(index: number): void { this.rtFlags[index] = 1; }
    isRenderTarget(index: number): boolean { return this.rtFlags[index] !== 0; }
    markCube(index: number): void { this.cubeFlags[index] = 1; }
    isCubeMap(index: number): boolean { return this.cubeFlags[index] !== 0; }

    lock(index: number): { ptr: number; pitch: number } | null {
        const guestBase = this.guestPtrs[index];
        if (guestBase < 0) return null;
        this.lockedPtrs[index] = guestBase;
        return { ptr: guestBase, pitch: this.pitches[index] };
    }

    unlock(index: number, memory: Uint8Array): void {
        const guestBase = this.guestPtrs[index];
        if (guestBase < 0 || this.lockedPtrs[index] === -1) return;
        const pitch = this.pitches[index];
        const height = this.heights[index];
        // Compressed surfaces hold height/4 block rows, not `height` rows; with the
        // block-row pitch this avoids copying ~height*3/4 of adjacent guest memory.
        const rows = getD3DTextureLayout(this.formats[index], this.widths[index], height).rows;
        const bytes = pitch * rows;
        const data = this.data[index];
        if (data) {
            data.set(memory.subarray(guestBase, guestBase + bytes));
        }
        this.lockedPtrs[index] = -1;
        this.dirtyFlags[index] = 1;
    }

    private grow(): void {
        const newCapacity = this.capacity * 2;

        const newWidths = new Uint32Array(newCapacity);
        newWidths.set(this.widths);
        this.widths = newWidths;

        const newHeights = new Uint32Array(newCapacity);
        newHeights.set(this.heights);
        this.heights = newHeights;

        const newLevels = new Uint32Array(newCapacity);
        newLevels.set(this.levels);
        this.levels = newLevels;

        const newFormats = new Uint32Array(newCapacity);
        newFormats.set(this.formats);
        this.formats = newFormats;

        const newData = new Array(newCapacity);
        for (let i = 0; i < this.data.length; i++) newData[i] = this.data[i];
        this.data = newData;

        const newGpuTextures = new Array(newCapacity).fill(null);
        for (let i = 0; i < this.gpuTextures.length; i++) newGpuTextures[i] = this.gpuTextures[i];
        this.gpuTextures = newGpuTextures;

        const newViews = new Array(newCapacity).fill(null);
        for (let i = 0; i < this.views.length; i++) newViews[i] = this.views[i];
        this.views = newViews;

        const newLockedPtrs = new Int32Array(newCapacity).fill(-1);
        newLockedPtrs.set(this.lockedPtrs);
        this.lockedPtrs = newLockedPtrs;

        const newGuestPtrs = new Int32Array(newCapacity).fill(-1);
        newGuestPtrs.set(this.guestPtrs);
        this.guestPtrs = newGuestPtrs;

        const newPitches = new Uint32Array(newCapacity);
        newPitches.set(this.pitches);
        this.pitches = newPitches;

        const newDirtyFlags = new Uint8Array(newCapacity);
        newDirtyFlags.set(this.dirtyFlags);
        this.dirtyFlags = newDirtyFlags;

        const newGenerations = new Uint16Array(newCapacity);
        newGenerations.set(this.generations);
        this.generations = newGenerations;

        const newRtFlags = new Uint8Array(newCapacity);
        newRtFlags.set(this.rtFlags);
        this.rtFlags = newRtFlags;

        const newCubeFlags = new Uint8Array(newCapacity);
        newCubeFlags.set(this.cubeFlags);
        this.cubeFlags = newCubeFlags;

        this.capacity = newCapacity;
    }

    // Debug export: get all textures info
    getAllDebugInfo(): Array<{
        index: number;
        handle: number;
        width: number;
        height: number;
        levels: number;
        format: number;
        isDirty: boolean;
        isLocked: boolean;
        hasGpuTexture: boolean;
    }> {
        const result: Array<{
            index: number;
            handle: number;
            width: number;
            height: number;
            levels: number;
            format: number;
            isDirty: boolean;
            isLocked: boolean;
            hasGpuTexture: boolean;
        }> = [];
        
        for (const [handle, packed] of this.handleToIndex.entries()) {
            const index = packed & 0xFFFF;
            const expectedGen = (packed >> 16) & 0xFFFF;
            if (this.generations[index] !== expectedGen) continue;
            if (this.data[index] === undefined) continue;
            
            result.push({
                index,
                handle,
                width: this.widths[index],
                height: this.heights[index],
                levels: this.levels[index],
                format: this.formats[index],
                isDirty: this.dirtyFlags[index] !== 0,
                isLocked: this.lockedPtrs[index] !== -1,
                hasGpuTexture: this.gpuTextures[index] !== null,
            });
        }
        
        return result;
    }
}
