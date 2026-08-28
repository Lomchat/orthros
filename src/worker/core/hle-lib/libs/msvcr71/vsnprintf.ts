import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';
import { encodeAnsi, formatCLazy, type VaArgReader } from '../../../../modules/crt-format';
import type { ShadowSpec, ShadowView } from '../../types';

const MAX_FORMAT = 16_384;
const MAX_OUTPUT = 65_536;

function readCString(view: ShadowView, address: number, maxLength: number): string {
    let out = '';
    const limit = Math.min(maxLength, MAX_FORMAT);
    for (let i = 0; i < limit; i++) {
        const byte = view.readU8((address + i) >>> 0);
        if (byte === 0) return out;
        out += String.fromCharCode(byte);
    }
    throw new Error('MSVCR71 _vsnprintf string exceeds its bounded scan');
}

class ShadowVaListReader implements VaArgReader {
    private offset = 0;

    constructor(private readonly view: ShadowView, private readonly base: number) {}

    nextUint32(): number {
        const value = this.view.readU32((this.base + this.offset) >>> 0) >>> 0;
        this.offset += 4;
        return value;
    }

    nextDouble(): number {
        const lo = this.nextUint32();
        const hi = this.nextUint32();
        const buffer = new ArrayBuffer(8);
        const dv = new DataView(buffer);
        dv.setUint32(0, lo, true);
        dv.setUint32(4, hi, true);
        return dv.getFloat64(0, true);
    }
}

function containsPercentN(format: string): boolean {
    for (let i = 0; i < format.length; i++) {
        if (format[i] !== '%') continue;
        i++;
        if (format[i] === '%') continue;
        while (i < format.length && !/[a-zA-Z%]/.test(format[i])) i++;
        if (format[i] === 'n') return true;
    }
    return false;
}

export function msvcr71VsnprintfKernel(view: ShadowView, args: number[]): number {
    const dest = args[0] >>> 0;
    const count = args[1] >>> 0;
    const fmt = args[2] >>> 0;
    const vaList = args[3] >>> 0;
    const format = readCString(view, fmt, MAX_FORMAT);
    const text = formatCLazy(
        format,
        new ShadowVaListReader(view, vaList),
        (address, maxLength) => readCString(view, address >>> 0, maxLength),
    );
    const bytes = encodeAnsi(text);
    if (bytes.length < count) {
        view.writeBytes(dest, bytes);
        view.writeU8((dest + bytes.length) >>> 0, 0);
        return bytes.length | 0;
    }
    view.writeBytes(dest, bytes.subarray(0, count));
    return -1;
}

export const msvcr71VsnprintfShadow: ShadowSpec = {
    ranges: (args) => [{ addr: args[0] >>> 0, len: args[1] >>> 0 }],
    guard: (args, view) => {
        const dest = args[0] >>> 0;
        const count = args[1] >>> 0;
        const fmt = args[2] >>> 0;
        const vaList = args[3] >>> 0;
        if (!dest || !fmt || !vaList || count === 0 || count > MAX_OUTPUT) return false;
        try {
            return !containsPercentN(readCString(view, fmt, MAX_FORMAT));
        } catch {
            return false;
        }
    },
    kernel: msvcr71VsnprintfKernel,
    n: 64,
    validateInGame: true,
};

export const msvcr71VsnprintfFallback: ThunkImplementation = (_ctx, _mem, _args) => {
    // ShadowHookRuntime replaces this handler with the guarded kernel. Keeping
    // an explicit fallback satisfies the descriptor contract and makes an
    // accidental non-shadow registration fail closed.
    return -1;
};
