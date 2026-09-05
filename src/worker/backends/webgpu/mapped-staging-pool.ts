/**
 * Upload buffers that stay mapped between frames. A buffer created mapped costs
 * a createBuffer and a destroy per frame (each a call into the GPU process);
 * one that is mapped again after the submit is a memory range next frame.
 * acquire() hands out a buffer already mapped for writing with the capacity
 * asked for, creating one only when none is ready; recycleAfterSubmit() maps
 * the frame's buffers again once the submit that read them has been queued —
 * mapping earlier would fail that submit's validation.
 */
export class MappedStagingPool {
    private readonly ready = new Map<number, GPUBuffer[]>();
    private readonly usedThisFrame: GPUBuffer[] = [];
    created = 0;
    reused = 0;
    destroyed = 0;

    constructor(private readonly device: GPUDevice, private readonly maxPerClass = 4) {}

    /** A buffer mapped for writing, usable as a copy source, capacity >= size. */
    acquire(size: number): GPUBuffer {
        let cap = 1 << 16;
        while (cap < size) cap *= 2;
        for (let c = cap; c <= (1 << 30); c *= 2) {
            const list = this.ready.get(c);
            if (list && list.length > 0) {
                const b = list.pop()!;
                this.usedThisFrame.push(b);
                this.reused++;
                return b;
            }
        }
        const b = this.device.createBuffer({
            label: "d3d9-staging",
            size: cap,
            usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.MAP_WRITE,
            mappedAtCreation: true,
        });
        this.usedThisFrame.push(b);
        this.created++;
        return b;
    }

    /** After queue.submit: map the frame's buffers again so the next frame reuses them. */
    recycleAfterSubmit(): void {
        for (let i = 0; i < this.usedThisFrame.length; i++) {
            const b = this.usedThisFrame[i]!;
            const cap = b.size;
            const list = this.ready.get(cap);
            if (list && list.length >= this.maxPerClass) { b.destroy(); this.destroyed++; continue; }
            b.mapAsync(GPUMapMode.WRITE).then(
                () => {
                    let l = this.ready.get(cap);
                    if (!l) { l = []; this.ready.set(cap, l); }
                    l.push(b);
                },
                () => { b.destroy(); this.destroyed++; },
            );
        }
        this.usedThisFrame.length = 0;
    }

    destroy(): void {
        for (const list of this.ready.values()) for (const b of list) b.destroy();
        this.ready.clear();
        for (const b of this.usedThisFrame) b.destroy();
        this.usedThisFrame.length = 0;
    }
}
