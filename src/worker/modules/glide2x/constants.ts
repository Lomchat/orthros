export const FXTRUE = 1;
export const FXFALSE = 0;

export const GLIDE_VERSION_STRING = "2.46 BottleShip WebGPU";

export const GLIDE_DEFAULT_WIDTH = 640;
export const GLIDE_DEFAULT_HEIGHT = 480;

export const GLIDE_MAX_SSTS = 1;
export const GLIDE_FBRAM_MB = 4;
export const GLIDE_TMU_COUNT = 2;
export const GLIDE_TMU_MEMORY_BYTES = 4 * 1024 * 1024;

export const GLIDE_EVENT_RING_CAPACITY = 256;
export const GLIDE_LFB_GUARD_BYTES = 32;
export const GLIDE_LFB_CANARY_VALUE = 0xa5;

// GrHwConfiguration (minimal subset used by games/drivers)
export const GR_HWCONFIG_NUM_SST_OFFSET = 0x00;
export const GR_HWCONFIG_SST0_TYPE_OFFSET = 0x04;
export const GR_HWCONFIG_SST0_FBRAM_OFFSET = 0x08;
export const GR_HWCONFIG_SST0_FBIREV_OFFSET = 0x0c;

// GrTexInfo
export const GR_TEXINFO_SMALL_LOD_OFFSET = 0x00;
export const GR_TEXINFO_LARGE_LOD_OFFSET = 0x04;
export const GR_TEXINFO_ASPECT_OFFSET = 0x08;
export const GR_TEXINFO_FORMAT_OFFSET = 0x0c;
export const GR_TEXINFO_DATA_OFFSET = 0x10;
export const GR_TEXINFO_SIZE = 0x14;

// GrLfbInfo (pragmatic subset for lock/unlock path)
export const GR_LFBINFO_SIZE_OFFSET = 0x00;
export const GR_LFBINFO_LFBPTR_OFFSET = 0x04;
export const GR_LFBINFO_STRIDE_OFFSET = 0x08;
export const GR_LFBINFO_WRITE_MODE_OFFSET = 0x0c;
export const GR_LFBINFO_ORIGIN_OFFSET = 0x10;
// sizeof(GrLfbInfo_t) per glide.h: { int size; void* lfbPtr; FxU32 stride;
// GrLfbWriteMode_t writeMode; GrOriginLocation_t origin; } = 5 * 4 = 20 bytes (0x14).
// This is the value grLfbLock reports back in info->size.
export const GR_LFBINFO_SIZE = 0x14;

// sizeof(GrState) — the public glide2x GrState is `char pad[GLIDE_STATE_PAD_SIZE]`
// where GLIDE_STATE_PAD_SIZE == 312 (glide.h). grGlideGetState/SetState must not
// write past this or they corrupt guest memory adjacent to the caller's struct.
export const GR_STATE_SIZE = 312;

// Pragmatic GrVertex view used by draw calls.
export const GR_VERTEX_X_OFFSET = 0x00;
export const GR_VERTEX_Y_OFFSET = 0x04;
export const GR_VERTEX_Z_OFFSET = 0x08;
export const GR_VERTEX_R_OFFSET = 0x0c;
export const GR_VERTEX_G_OFFSET = 0x10;
export const GR_VERTEX_B_OFFSET = 0x14;
export const GR_VERTEX_OOZ_OFFSET = 0x18;
export const GR_VERTEX_A_OFFSET = 0x1c;
export const GR_VERTEX_OOW_OFFSET = 0x20;
export const GR_VERTEX_SOW_OFFSET = 0x24;
export const GR_VERTEX_TOW_OFFSET = 0x28;
export const GR_VERTEX_TMU0_OOW_OFFSET = 0x2c;
export const GR_VERTEX_SIZE = 0x24 + (GLIDE_TMU_COUNT * 0x0c);

export const GR_BUFFER_FRONTBUFFER = 0;
export const GR_BUFFER_BACKBUFFER = 1;
export const GR_BUFFER_AUXBUFFER = 2;

export const GR_LFB_READ_ONLY = 0;
export const GR_LFB_WRITE_ONLY = 1;
export const GR_LFB_READ_WRITE = 2;

export const GR_LFBWRITEMODE_565 = 0;
export const GR_LFBWRITEMODE_555 = 1;
export const GR_LFBWRITEMODE_1555 = 2;
export const GR_LFBWRITEMODE_888 = 4;
export const GR_LFBWRITEMODE_8888 = 5;
export const GR_LFBWRITEMODE_565_DEPTH = 0x0c;
export const GR_LFBWRITEMODE_555_DEPTH = 0x0d;
export const GR_LFBWRITEMODE_1555_DEPTH = 0x0e;
export const GR_LFBWRITEMODE_ZA16 = 0x0f;
export const GR_LFBWRITEMODE_ANY = 0xff;

export const GR_LFB_SRC_FMT_565 = 0x00;
export const GR_LFB_SRC_FMT_555 = 0x01;
export const GR_LFB_SRC_FMT_1555 = 0x02;
export const GR_LFB_SRC_FMT_888 = 0x04;
export const GR_LFB_SRC_FMT_8888 = 0x05;
export const GR_LFB_SRC_FMT_565_DEPTH = 0x0c;
export const GR_LFB_SRC_FMT_555_DEPTH = 0x0d;
export const GR_LFB_SRC_FMT_1555_DEPTH = 0x0e;
export const GR_LFB_SRC_FMT_ZA16 = 0x0f;
export const GR_LFB_SRC_FMT_RLE16 = 0x80;

// GrColorFormat_t — LFB write lane order (glide.h)
export const GR_COLORFORMAT_ARGB = 0x0;
export const GR_COLORFORMAT_ABGR = 0x1;
export const GR_COLORFORMAT_RGBA = 0x2;
export const GR_COLORFORMAT_BGRA = 0x3;

export const GR_CULL_DISABLE = 0;
export const GR_CULL_NEGATIVE = 1;
export const GR_CULL_POSITIVE = 2;

export const GR_ORIGIN_UPPER_LEFT = 0;
export const GR_ORIGIN_LOWER_LEFT = 1;

// glide.h: ZBUFFER=1, WBUFFER=2 (these were previously swapped).
export const GR_DEPTHBUFFER_DISABLE = 0;
export const GR_DEPTHBUFFER_ZBUFFER = 1;
export const GR_DEPTHBUFFER_WBUFFER = 2;
export const GR_DEPTHBUFFER_ZBUFFER_COMPARE_TO_BIAS = 3;
export const GR_DEPTHBUFFER_WBUFFER_COMPARE_TO_BIAS = 4;

// GrCmpFnc_t (depth + alpha compare functions)
export const GR_CMP_NEVER = 0;
export const GR_CMP_LESS = 1;
export const GR_CMP_EQUAL = 2;
export const GR_CMP_LEQUAL = 3;
export const GR_CMP_GREATER = 4;
export const GR_CMP_NOTEQUAL = 5;
export const GR_CMP_GEQUAL = 6;
export const GR_CMP_ALWAYS = 7;

export function bytesPerPixelForLfbWriteMode(writeMode: number): number {
    switch (writeMode | 0) {
        case GR_LFBWRITEMODE_888:
        case GR_LFBWRITEMODE_8888:
        case GR_LFBWRITEMODE_565_DEPTH:
        case GR_LFBWRITEMODE_555_DEPTH:
        case GR_LFBWRITEMODE_1555_DEPTH:
            return 4;
        case GR_LFBWRITEMODE_ZA16:
        case GR_LFBWRITEMODE_565:
        case GR_LFBWRITEMODE_555:
        case GR_LFBWRITEMODE_1555:
        default:
            return 2;
    }
}
