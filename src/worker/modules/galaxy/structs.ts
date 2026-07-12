import { Mem } from '../../core/memory/mem-accessor';
import { Logger, LogCategory } from '../../core/logger';
import type { Process } from '../../core/process';

const RIFF = 0x46464952; // 'RIFF'
const WAVE = 0x45564157; // 'WAVE'

export interface USoundLayout {
    /** USound->Data.Num() — byte length of sample payload. */
    dataNum: number;
    /** Pointer to embedded PCM or RIFF blob. */
    dataPtr: number;
    /** glxSample* written by RegisterSound; read by GetSound. */
    glxSample: number;
    /** Fallback scan range start (UObject tail). */
    probeStart: number;
    probeEnd: number;
    /** When false, HLE must not write guest USound fields (fail-closed). */
    confirmed?: boolean;
}

export const DEFAULT_USOUND_LAYOUT: USoundLayout = {
    dataNum: 0x34,
    dataPtr: 0x38,
    glxSample: 0x68,
    probeStart: 0x3c,
    probeEnd: 0xa0,
};

export interface GuestWaveInfo {
    dataPtr: number;
    dataSize: number;
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
}

/** Resolve wave bytes from a UE1 USound (Galaxy RegisterSound field layout). */
export function probeUSoundWave(usoundPtr: number, layout: USoundLayout): GuestWaveInfo | null {
    if (!usoundPtr) return null;

    const dataNum = Mem.readUint32(usoundPtr + layout.dataNum) ?? 0;
    const dataPtr = Mem.readUint32(usoundPtr + layout.dataPtr) ?? 0;
    if (dataPtr && dataNum >= 4) {
        const riff = tryWaveAt(dataPtr);
        if (riff) return riff;
        if (dataNum >= 64 && looksLikePcm(dataPtr, Math.min(dataNum, 4096))) {
            return {
                dataPtr,
                dataSize: dataNum,
                sampleRate: 22050,
                channels: 1,
                bitsPerSample: 16,
            };
        }
    }

    // TArray-style fallback @ +0x28: { Data*, Num, Max }
    const arrPtr = Mem.readUint32(usoundPtr + 0x28) ?? 0;
    const arrNum = Mem.readUint32(usoundPtr + 0x2c) ?? 0;
    if (arrPtr && arrNum >= 4) {
        const riff = tryWaveAt(arrPtr);
        if (riff) return riff;
        if (arrNum >= 64 && looksLikePcm(arrPtr, Math.min(arrNum, 4096))) {
            return {
                dataPtr: arrPtr,
                dataSize: arrNum,
                sampleRate: 22050,
                channels: 1,
                bitsPerSample: 16,
            };
        }
    }

    for (let off = layout.probeStart; off <= layout.probeEnd; off += 4) {
        const direct = tryWaveAt(usoundPtr + off);
        if (direct) return direct;
        const p = Mem.readUint32(usoundPtr + off) ?? 0;
        if (p) {
            const indirect = tryWaveAt(p);
            if (indirect) return indirect;
        }
    }
    return null;
}

function looksLikePcm(addr: number, sampleBytes: number): boolean {
    let nonZero = 0;
    for (let i = 0; i < sampleBytes; i += 2) {
        const v = Mem.readInt16(addr + i) ?? 0;
        if (v !== 0) nonZero++;
    }
    return nonZero > sampleBytes / 8;
}

function tryWaveAt(addr: number): GuestWaveInfo | null {
    if (!addr || addr < 0x10000) return null;
    if ((Mem.readUint32(addr) ?? 0) !== RIFF) return null;
    if ((Mem.readUint32(addr + 8) ?? 0) !== WAVE) return null;

    let pos = 12;
    let sampleRate = 22050;
    let channels = 1;
    let bitsPerSample = 16;
    let dataPtr = 0;
    let dataSize = 0;

    for (let i = 0; i < 16; i++) {
        const abs = addr + pos;
        if (pos + 8 > 0x100000) break;
        const chunkId = Mem.readUint32(abs) ?? 0;
        const chunkSize = Mem.readUint32(abs + 4) ?? 0;
        pos += 8;
        if (chunkId === 0x20746d66) { // 'fmt '
            const audioFormat = Mem.readUint16(abs) ?? 1;
            channels = Mem.readUint16(abs + 2) ?? 1;
            sampleRate = Mem.readUint32(abs + 4) ?? 22050;
            bitsPerSample = Mem.readUint16(abs + 14) ?? 16;
            if (audioFormat !== 1) return null;
        } else if (chunkId === 0x61746164) { // 'data'
            dataPtr = addr + pos;
            dataSize = chunkSize;
            break;
        }
        pos += chunkSize + (chunkSize & 1);
    }

    if (!dataPtr || !dataSize) return null;
    return { dataPtr, dataSize, sampleRate, channels, bitsPerSample };
}

/** Guest glxSample stub size (voice metadata; engine only needs non-null). */
export const GLX_SAMPLE_SIZE = 0x80;

export function allocGlxSample(process: Process): number {
    const ptr = process.memory.alloc(GLX_SAMPLE_SIZE, 'HEAP');
    for (let i = 0; i < GLX_SAMPLE_SIZE; i += 4) {
        Mem.writeUint32(ptr + i, 0);
    }
    return ptr;
}

export function bindGlxSampleToUSound(usoundPtr: number, glxSamplePtr: number, layout: USoundLayout): void {
    if (!layout.confirmed) {
        Logger.warn(LogCategory.SYSTEM, `[Galaxy] bindGlxSampleToUSound skipped — USound layout not confirmed`);
        return;
    }
    Mem.writeUint32(usoundPtr + layout.glxSample, glxSamplePtr >>> 0);
}
