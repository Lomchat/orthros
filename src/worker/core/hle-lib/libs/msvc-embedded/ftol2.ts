import { fpuGetST, fpuPop } from '../../../fpu-helper';
import { System } from '../../../system';
import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';

const TWO32 = 0x1_0000_0000;
const TWO63 = 9_223_372_036_854_775_808;

/** Split classic MSVC `_ftol2_sse` truncation into EDX:EAX. Invalid and
 * overflowing values use x87's indefinite integer instead of JS saturation. */
export function ftol2SseHalves(value: number): { low: number; high: number } {
    if (!Number.isFinite(value) || value >= TWO63 || value < -TWO63) {
        return { low: 0, high: -0x8000_0000 };
    }
    const truncated = Math.trunc(value);
    return {
        low: truncated >>> 0,
        high: Math.floor(truncated / TWO32) | 0,
    };
}

/** Emergency JS tier. Production calls are served by WASM handler 17. */
export const msvcEmbeddedFtol2Handler: ThunkImplementation = () => {
    const process = System.getInstance().process;
    if (!process) return 0;
    const value = fpuGetST(process.v86, 0);
    const { low, high } = ftol2SseHalves(value);
    fpuPop(process.v86);
    const registers = (process.dispatcher as any)?.cachedReg32;
    if (registers) registers[2] = high;
    return low | 0;
};
