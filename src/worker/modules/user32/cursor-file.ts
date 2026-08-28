import { decodeIconResource } from "../kernel32/icon-extractor";

export interface CursorFrame {
    width: number;
    height: number;
    hotspotX: number;
    hotspotY: number;
    pixels: Uint8Array;
}

export interface CursorAnimation {
    frames: CursorFrame[];
    sequence: number[];
    delaysMs: number[];
}

function fourCC(data: Uint8Array, offset: number): string {
    if (offset < 0 || offset + 4 > data.length) return "";
    return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

/** Decode the best image in a Windows .cur file (also used by ANI `icon` chunks). */
export function decodeCursorFile(data: Uint8Array): CursorFrame | null {
    if (data.length < 22) return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const reserved = view.getUint16(0, true);
    const kind = view.getUint16(2, true);
    // A few legacy IconCool ANI files (including BFME's Beam.ani) write 0x0200
    // into the reserved word and ICO type 1, while keeping CUR hotspot entries.
    const legacyIconCoolCursor = reserved === 0x0200 && kind === 1;
    if (!legacyIconCoolCursor && (reserved !== 0 || kind !== 2)) return null;
    const count = view.getUint16(4, true);
    if (!count || 6 + count * 16 > data.length) return null;

    let best: CursorFrame | null = null;
    for (let i = 0; i < count; i++) {
        const entry = 6 + i * 16;
        const hotspotX = view.getUint16(entry + 4, true);
        const hotspotY = view.getUint16(entry + 6, true);
        const byteLength = view.getUint32(entry + 8, true);
        const imageOffset = view.getUint32(entry + 12, true);
        if (!byteLength || imageOffset + byteLength > data.length) continue;
        const decoded = decodeIconResource(data.subarray(imageOffset, imageOffset + byteLength));
        if (!decoded) continue;
        const candidate: CursorFrame = { ...decoded, hotspotX, hotspotY };
        if (!best || candidate.width * candidate.height > best.width * best.height) best = candidate;
    }
    return best;
}

function collectAniChunks(
    data: Uint8Array,
    start: number,
    end: number,
    icons: Uint8Array[],
    state: { jifRate: number; rates: number[]; sequence: number[] },
): void {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = start;
    while (offset + 8 <= end && offset + 8 <= data.length) {
        const id = fourCC(data, offset);
        const size = view.getUint32(offset + 4, true);
        const payload = offset + 8;
        const payloadEnd = payload + size;
        if (payloadEnd > end || payloadEnd > data.length) break;

        if (id === "anih" && size >= 36) {
            state.jifRate = view.getUint32(payload + 28, true) || 6;
        } else if (id === "rate") {
            state.rates = [];
            for (let p = payload; p + 4 <= payloadEnd; p += 4) state.rates.push(view.getUint32(p, true));
        } else if (id === "seq ") {
            state.sequence = [];
            for (let p = payload; p + 4 <= payloadEnd; p += 4) state.sequence.push(view.getUint32(p, true));
        } else if (id === "icon") {
            icons.push(data.slice(payload, payloadEnd));
        } else if (id === "LIST" && size >= 4) {
            collectAniChunks(data, payload + 4, payloadEnd, icons, state);
        }

        offset = payloadEnd + (size & 1);
    }
}

/** Decode either a static .cur or a RIFF/ACON animated cursor. */
export function decodeWindowsCursor(data: Uint8Array): CursorAnimation | null {
    const staticFrame = decodeCursorFile(data);
    if (staticFrame) return { frames: [staticFrame], sequence: [0], delaysMs: [0] };

    if (data.length < 12 || fourCC(data, 0) !== "RIFF" || fourCC(data, 8) !== "ACON") return null;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const riffEnd = Math.min(data.length, 8 + view.getUint32(4, true));
    const icons: Uint8Array[] = [];
    const state = { jifRate: 6, rates: [] as number[], sequence: [] as number[] };
    collectAniChunks(data, 12, riffEnd, icons, state);

    const frames = icons.map(decodeCursorFile).filter((frame): frame is CursorFrame => frame !== null);
    if (!frames.length) return null;
    const rawSequence = state.sequence.length ? state.sequence : frames.map((_, index) => index);
    const sequence = rawSequence.filter((index) => index >= 0 && index < frames.length);
    if (!sequence.length) sequence.push(0);
    const delaysMs = sequence.map((_, step) => {
        const jiffies = state.rates[step] || state.jifRate || 6;
        return Math.max(16, Math.round(jiffies * (1000 / 60)));
    });
    return { frames, sequence, delaysMs };
}
