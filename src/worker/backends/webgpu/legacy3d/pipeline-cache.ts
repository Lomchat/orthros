export class PipelineCache<T> {
    private readonly map = new Map<string, T>();
    private hitsCount = 0;
    private missesCount = 0;

    get(key: string): T | undefined {
        const value = this.map.get(key);
        if (value !== undefined) {
            this.hitsCount++;
        } else {
            this.missesCount++;
        }
        return value;
    }

    set(key: string, value: T): void {
        this.map.set(key, value);
    }

    clear(): void {
        this.map.clear();
        this.hitsCount = 0;
        this.missesCount = 0;
    }

    size(): number {
        return this.map.size;
    }

    getStats(): { hits: number; misses: number; size: number } {
        return {
            hits: this.hitsCount,
            misses: this.missesCount,
            size: this.map.size,
        };
    }
}
