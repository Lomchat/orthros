/**
 * Object pool for Rect instances to reduce allocations in hot paths.
 *
 * Usage:
 * ```ts
 * const pool = new RectPool();
 * const rect = pool.acquire();
 * rect.left = 10; rect.top = 20; rect.right = 100; rect.bottom = 200;
 * // ... use rect ...
 * pool.release(rect);
 * ```
 */

import type { Rect } from "./helpers";

export class RectPool {
    private pool: Rect[] = [];
    private allocated = new Set<Rect>();

    constructor(initialSize: number = 8) {
        // Pre-allocate pool
        for (let i = 0; i < initialSize; i++) {
            this.pool.push({ left: 0, top: 0, right: 0, bottom: 0 });
        }
    }

    /**
     * Acquire a Rect from the pool. Caller must release it when done.
     */
    acquire(): Rect {
        const rect = this.pool.pop() || { left: 0, top: 0, right: 0, bottom: 0 };
        this.allocated.add(rect);
        return rect;
    }

    /**
     * Copy values from source to a pooled rect.
     */
    acquireCopy(src: Rect): Rect {
        const rect = this.acquire();
        rect.left = src.left;
        rect.top = src.top;
        rect.right = src.right;
        rect.bottom = src.bottom;
        return rect;
    }

    /**
     * Release a Rect back to the pool.
     */
    release(rect: Rect): void {
        if (!this.allocated.has(rect)) {
            // Already released or not from this pool
            return;
        }
        this.allocated.delete(rect);
        // Reset to zero for debugging
        rect.left = 0;
        rect.top = 0;
        rect.right = 0;
        rect.bottom = 0;
        this.pool.push(rect);
    }

    /**
     * Release all allocated rects (for batch cleanup).
     */
    releaseAll(): void {
        for (const rect of this.allocated) {
            rect.left = 0;
            rect.top = 0;
            rect.right = 0;
            rect.bottom = 0;
            this.pool.push(rect);
        }
        this.allocated.clear();
    }
}
