/**
 * Shared FFP Renderer — canonical import point for D3D8/D3D9.
 *
 * The renderer itself lives in ddraw/ (battle-tested, 3500+ LOC).
 * This facade re-exports it under version-neutral names so D3D8 and D3D9
 * modules don't import from "ddraw/" directly.
 *
 * Architecture:
 *   DDraw/D3D7 → ddraw-backend-executor.ts (direct import, unchanged)
 *   D3D8       → shared/index.ts → ddraw-backend-executor.ts
 *   D3D9       → shared/index.ts → ddraw-backend-executor.ts
 */

// The shared FFP renderer (aliased from DDraw executor)
export { DDrawWebGPUExecutor as FFPRenderer } from '../ddraw/ddraw-backend-executor';

// Surface state types (used by all D3D versions)
export type {
    DirectDrawSurfaceState,
    BitmapTextureSurface,
    RenderSurface,
    BaseSurfaceState,
    SurfaceFormat,
} from '../../../modules/ddraw/com-objects';

// Type guards for surface discrimination
export {
    isBitmapTexture,
    isRenderSurface,
} from '../../../modules/ddraw/com-objects';

// Pipeline and viewport types
export type { Viewport } from '../ddraw/types';
export type { PipelineKeyConfig } from '../ddraw/types';
