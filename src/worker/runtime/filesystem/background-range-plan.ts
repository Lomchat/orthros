/**
 * Plan background HTTP extents independently from the durable cache chunk size.
 * Mostly-empty runs collapse to one large transfer; sparse holes remain precise.
 */
export function planBackgroundSpans(
    firstChunk: number,
    endChunk: number,
    hasChunk: (index: number) => boolean,
): Array<[startChunk: number, endChunk: number]> {
    const missing: number[] = [];
    for (let index = firstChunk; index < endChunk; index++) if (!hasChunk(index)) missing.push(index);
    if (missing.length === 0) return [];
    if (missing.length * 2 >= endChunk - firstChunk) {
        return [[missing[0]!, missing[missing.length - 1]! + 1]];
    }

    const spans: Array<[number, number]> = [];
    let start = missing[0]!;
    let previous = start;
    for (let i = 1; i < missing.length; i++) {
        const index = missing[i]!;
        if (index !== previous + 1) {
            spans.push([start, previous + 1]);
            start = index;
        }
        previous = index;
    }
    spans.push([start, previous + 1]);
    return spans;
}
