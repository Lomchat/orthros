export type LruCacheOptions<K, V> = {
    maxEntries?: number;
    maxBytes?: number;
    sizeOf?: (value: V, key: K) => number;
    onEvict?: (key: K, value: V) => void;
    canEvict?: (key: K, value: V) => boolean;
};

type LruNode<K, V> = {
    key: K;
    value: V;
    size: number;
    prev: LruNode<K, V> | null;
    next: LruNode<K, V> | null;
};

export class LruCache<K, V> {
    private readonly maxEntries: number | null;
    private readonly maxBytes: number | null;
    private readonly sizeOf: (value: V, key: K) => number;
    private readonly onEvict?: (key: K, value: V) => void;
    private readonly canEvict?: (key: K, value: V) => boolean;

    private readonly map = new Map<K, LruNode<K, V>>();
    private head: LruNode<K, V> | null = null;
    private tail: LruNode<K, V> | null = null;
    private totalBytes = 0;

    constructor(options: LruCacheOptions<K, V> = {}) {
        this.maxEntries = options.maxEntries !== undefined ? Math.max(0, options.maxEntries) : null;
        this.maxBytes = options.maxBytes !== undefined ? Math.max(0, options.maxBytes) : null;
        this.sizeOf = options.sizeOf ?? (() => 1);
        this.onEvict = options.onEvict;
        this.canEvict = options.canEvict;
    }

    get size(): number {
        return this.map.size;
    }

    get byteSize(): number {
        return this.totalBytes;
    }

    has(key: K): boolean {
        return this.map.has(key);
    }

    get(key: K): V | undefined {
        const node = this.map.get(key);
        if (!node) return undefined;
        this.moveToFront(node);
        return node.value;
    }

    peek(key: K): V | undefined {
        return this.map.get(key)?.value;
    }

    touch(key: K): boolean {
        const node = this.map.get(key);
        if (!node) return false;
        this.moveToFront(node);
        return true;
    }

    set(key: K, value: V): boolean {
        const size = this.sizeOf(value, key);
        if (this.maxBytes !== null && size > this.maxBytes) {
            this.delete(key);
            return false;
        }

        const existing = this.map.get(key);
        if (existing) {
            this.totalBytes += size - existing.size;
            existing.value = value;
            existing.size = size;
            this.moveToFront(existing);
            this.evictToLimits();
            return true;
        }

        const node: LruNode<K, V> = {
            key,
            value,
            size,
            prev: null,
            next: null,
        };
        this.map.set(key, node);
        this.addToFront(node);
        this.totalBytes += size;
        this.evictToLimits();
        return true;
    }

    delete(key: K): boolean {
        const node = this.map.get(key);
        if (!node) return false;
        this.unlink(node);
        this.map.delete(key);
        this.totalBytes -= node.size;
        return true;
    }

    clear(): void {
        if (this.onEvict) {
            for (const [key, value] of this.entries()) {
                this.onEvict(key, value);
            }
        }
        this.map.clear();
        this.head = null;
        this.tail = null;
        this.totalBytes = 0;
    }

    *entries(): IterableIterator<[K, V]> {
        let node = this.head;
        while (node) {
            const current = node;
            node = node.next;
            yield [current.key, current.value];
        }
    }

    *keys(): IterableIterator<K> {
        for (const [key] of this.entries()) {
            yield key;
        }
    }

    *values(): IterableIterator<V> {
        for (const [, value] of this.entries()) {
            yield value;
        }
    }

    [Symbol.iterator](): IterableIterator<[K, V]> {
        return this.entries();
    }

    private addToFront(node: LruNode<K, V>): void {
        node.prev = null;
        node.next = this.head;
        if (this.head) {
            this.head.prev = node;
        }
        this.head = node;
        if (!this.tail) {
            this.tail = node;
        }
    }

    private moveToFront(node: LruNode<K, V>): void {
        if (node === this.head) return;
        this.unlink(node);
        this.addToFront(node);
    }

    private unlink(node: LruNode<K, V>): void {
        if (node.prev) {
            node.prev.next = node.next;
        } else {
            this.head = node.next;
        }
        if (node.next) {
            node.next.prev = node.prev;
        } else {
            this.tail = node.prev;
        }
        node.prev = null;
        node.next = null;
    }

    private evictToLimits(): void {
        const hasEntryLimit = this.maxEntries !== null;
        const hasByteLimit = this.maxBytes !== null;
        if (!hasEntryLimit && !hasByteLimit) return;

        while (
            (hasEntryLimit && this.map.size > (this.maxEntries as number)) ||
            (hasByteLimit && this.totalBytes > (this.maxBytes as number))
        ) {
            if (!this.evictLeast()) break;
        }
    }

    private evictLeast(): boolean {
        let node = this.tail;
        if (!node) return false;

        if (this.canEvict) {
            while (node && !this.canEvict(node.key, node.value)) {
                node = node.prev;
            }
            if (!node) return false;
        }

        this.unlink(node);
        this.map.delete(node.key);
        this.totalBytes -= node.size;
        if (this.onEvict) {
            this.onEvict(node.key, node.value);
        }
        return true;
    }
}
