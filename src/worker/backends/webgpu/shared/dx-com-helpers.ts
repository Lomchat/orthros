/**
 * Shared DirectX COM out-parameter hygiene (DXVK InitReturnPtr / Wine *out=NULL).
 */

import { Mem } from '../../../core/memory/mem-accessor';

export const D3DFMT_UNKNOWN = 0;
export const D3DFMT_P8 = 41;
export const D3DPOOL_SCRATCH = 3;

/** Zero a guest COM out-pointer before work or on failure. */
export function initReturnPtr(ptr: number): void {
    if (ptr) Mem.writeUint32(ptr, 0);
}

/** DXVK placeP8InScratch: palettized textures use SCRATCH pool on real drivers. */
export function normalizePalettizedTexturePool(format: number, pool: number): number {
    return (format >>> 0) === D3DFMT_P8 ? D3DPOOL_SCRATCH : (pool >>> 0);
}
