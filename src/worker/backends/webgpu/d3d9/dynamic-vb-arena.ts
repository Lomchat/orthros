/**
 * One vertex buffer per frame for every DrawPrimitiveUP: a draw bump-allocates
 * a range, copies its vertices into the CPU mirror, and the mirror crosses to
 * the GPU in a single queue.writeBuffer before the submit. Chromium serialises
 * each writeBuffer to the GPU process, so one per UP draw (and one staging copy
 * per draw) cost more than the draws. A frame that outgrows the buffer flushes
 * it, keeps it for the draws already recorded against it, and continues in a
 * larger one; the larger one survives for the next frame. Reusing the buffer
 * across frames needs no fence: the next frame's write is queued after this
 * frame's submit, and queue operations run in order.
 */
export class DynamicVbArena {
    buffer: GPUBuffer | null = null;
    private capacity = 0;
    private mirror = new Uint8Array(0);
    private cursor = 0;
    private flushed = 0;
    private retired: GPUBuffer[] = [];
    flushes = 0;
    grows = 0;
    bytesFlushed = 0;

    constructor(private readonly device: GPUDevice) {}

    /** Reserve `bytes` (rounded up to four) and return the byte offset in `buffer`. */
    alloc(bytes: number): number {
        const size = (bytes + 3) & ~3;
        if (!this.buffer || this.cursor + size > this.capacity) this.grow(size);
        const offset = this.cursor;
        this.cursor += size;
        return offset;
    }

    /** The mirror to copy vertices into, at the offset alloc returned. */
    get data(): Uint8Array { return this.mirror; }

    private grow(need: number): void {
        if (this.buffer) {
            this.flush();
            this.retired.push(this.buffer);
        }
        let cap = Math.max(1 << 16, this.capacity * 2);
        while (cap < need) cap *= 2;
        this.buffer = this.device.createBuffer({
            label: "d3d9-up-arena",
            size: cap,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        this.capacity = cap;
        this.mirror = new Uint8Array(cap);
        this.cursor = 0;
        this.flushed = 0;
        this.grows++;
    }

    /** Upload what was written since the last flush, in one call. */
    flush(): void {
        if (this.buffer && this.cursor > this.flushed) {
            this.device.queue.writeBuffer(this.buffer, this.flushed, this.mirror.buffer, this.flushed, this.cursor - this.flushed);
            this.bytesFlushed += this.cursor - this.flushed;
            this.flushed = this.cursor;
            this.flushes++;
        }
    }

    /** After the submit: buffers retired mid-frame are released and the arena rewinds. */
    endFrame(): void {
        for (let i = 0; i < this.retired.length; i++) this.retired[i]!.destroy();
        this.retired.length = 0;
        this.cursor = 0;
        this.flushed = 0;
    }
}
