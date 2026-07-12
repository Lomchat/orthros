/**
 * D3DX surface operations.
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { d3dxLoadSurfaceFromSurface } from '../d3d9/d3dx-bridge';

export function createSurfaceExports(): Record<string, ThunkImplementation> {
    return {
        D3DXLoadSurfaceFromSurface: (_ctx, mem, args) => {
            return d3dxLoadSurfaceFromSurface(
                mem,
                args[0] >>> 0,
                args[2] >>> 0,
                args[3] >>> 0,
                args[5] >>> 0,
                args[6] >>> 0,
                args[7] >>> 0,
            );
        },
    };
}
