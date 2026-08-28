/** Bounded zero-allocation-after-warmup ring of failed guest file probes. */

export interface MissingFileRecord {
    op: string;
    path: string;
    error: number;
    eip: number;
}

const CAPACITY = 64;
const records: Array<MissingFileRecord | undefined> = new Array(CAPACITY);
let count = 0;
let cursor = 0;

export function recordMissingFile(op: string, path: string, error: number, eip: number): void {
    records[cursor] = { op, path: path.slice(0, 2048), error: error >>> 0, eip: eip >>> 0 };
    cursor = (cursor + 1) % CAPACITY;
    if (count < CAPACITY) count++;
}

export function getMissingFiles(): MissingFileRecord[] {
    const out: MissingFileRecord[] = [];
    const start = count === CAPACITY ? cursor : 0;
    for (let i = 0; i < count; i++) {
        const record = records[(start + i) % CAPACITY];
        if (record) out.push({ ...record });
    }
    return out;
}

export function resetMissingFiles(): void {
    records.fill(undefined);
    count = 0;
    cursor = 0;
}
