// The guest surface to RGBA8 conversion of gfx/d3d8-webgl.js as it was before its table-driven 8/16-bit paths and
// its reused output buffer (reference for tests/texture-convert.test.js).
import { FMT, surfaceBytes } from '../../src/win32/d3d8.js';
import { decodeDxt } from '../../src/gfx/d3d8-webgl.js';
const isDxt = (f) => f === FMT.DXT1 || f === FMT.DXT2 || f === FMT.DXT3 || f === FMT.DXT4 || f === FMT.DXT5;

export function surfaceToRgbaRef(mem, fmt, addr, w, h, pitch) {
  if (isDxt(fmt)) return decodeDxt(fmt, mem.bytes(addr, surfaceBytes(fmt, w, h)), w, h);
  const out = new Uint8Array(w * h * 4);
  const u8 = mem.u8;
  let out32 = null;
  for (let y = 0; y < h; y++) {
    let s = addr + y * pitch, o = y * w * 4;
    switch (fmt) {
      case FMT.A8R8G8B8: case FMT.X8R8G8B8: {
        if ((s & 3) === 0) { // whole-pixel swizzle B,G,R,A -> R,G,B,A on 32-bit lanes
          const src = mem.u32, dst = out32 ?? (out32 = new Uint32Array(out.buffer)); const alpha = fmt === FMT.X8R8G8B8 ? 0xff000000 : 0;
          for (let x = 0, si = s >> 2, oi = o >> 2; x < w; x++, si++, oi++) { const p = src[si]; dst[oi] = ((p & 0xff00ff00) | ((p & 0xff) << 16) | ((p >>> 16) & 0xff) | alpha) >>> 0; }
        } else for (let x = 0; x < w; x++, s += 4, o += 4) { out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = fmt === FMT.X8R8G8B8 ? 255 : u8[s + 3]; }
        break;
      }
      case FMT.A8B8G8R8: case 33: for (let x = 0; x < w; x++, s += 4, o += 4) { out[o] = u8[s]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s + 2]; out[o + 3] = fmt === 33 ? 255 : u8[s + 3]; } break;
      case FMT.R8G8B8: for (let x = 0; x < w; x++, s += 3, o += 4) { out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = 255; } break;
      case FMT.R5G6B5: for (let x = 0; x < w; x++, s += 2, o += 4) { const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 11) & 31) * 255 / 31 | 0; out[o + 1] = ((v >> 5) & 63) * 255 / 63 | 0; out[o + 2] = (v & 31) * 255 / 31 | 0; out[o + 3] = 255; } break;
      case FMT.X1R5G5B5: case FMT.A1R5G5B5: for (let x = 0; x < w; x++, s += 2, o += 4) { const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 10) & 31) * 255 / 31 | 0; out[o + 1] = ((v >> 5) & 31) * 255 / 31 | 0; out[o + 2] = (v & 31) * 255 / 31 | 0; out[o + 3] = fmt === FMT.A1R5G5B5 ? (v & 0x8000 ? 255 : 0) : 255; } break;
      case FMT.A4R4G4B4: case FMT.X4R4G4B4: for (let x = 0; x < w; x++, s += 2, o += 4) { const v = u8[s] | (u8[s + 1] << 8); out[o] = ((v >> 8) & 15) * 17; out[o + 1] = ((v >> 4) & 15) * 17; out[o + 2] = (v & 15) * 17; out[o + 3] = fmt === FMT.A4R4G4B4 ? ((v >> 12) & 15) * 17 : 255; } break;
      case FMT.A8: for (let x = 0; x < w; x++, s++, o += 4) { out[o] = out[o + 1] = out[o + 2] = 0; out[o + 3] = u8[s]; } break;
      case FMT.L8: case FMT.P8: for (let x = 0; x < w; x++, s++, o += 4) { out[o] = out[o + 1] = out[o + 2] = u8[s]; out[o + 3] = 255; } break;
      case 81: for (let x = 0; x < w; x++, s += 2, o += 4) { out[o] = out[o + 1] = out[o + 2] = u8[s + 1]; out[o + 3] = 255; } break; // L16
      case FMT.A8L8: for (let x = 0; x < w; x++, s += 2, o += 4) { out[o] = out[o + 1] = out[o + 2] = u8[s]; out[o + 3] = u8[s + 1]; } break;
      case FMT.A4L4: for (let x = 0; x < w; x++, s++, o += 4) { const l = (u8[s] & 15) * 17; out[o] = out[o + 1] = out[o + 2] = l; out[o + 3] = (u8[s] >> 4) * 17; } break;
      case FMT.V8U8: for (let x = 0; x < w; x++, s += 2, o += 4) { out[o] = (u8[s] + 128) & 0xff; out[o + 1] = (u8[s + 1] + 128) & 0xff; out[o + 2] = 255; out[o + 3] = 255; } break;
      case FMT.Q8W8V8U8: for (let x = 0; x < w; x++, s += 4, o += 4) { out[o] = (u8[s] + 128) & 0xff; out[o + 1] = (u8[s + 1] + 128) & 0xff; out[o + 2] = (u8[s + 2] + 128) & 0xff; out[o + 3] = (u8[s + 3] + 128) & 0xff; } break;
      case FMT.V16U16: for (let x = 0; x < w; x++, s += 4, o += 4) { out[o] = (u8[s + 1] + 128) & 0xff; out[o + 1] = (u8[s + 3] + 128) & 0xff; out[o + 2] = 255; out[o + 3] = 255; } break;
      case FMT.G16R16: for (let x = 0; x < w; x++, s += 4, o += 4) { out[o] = u8[s + 1]; out[o + 1] = u8[s + 3]; out[o + 2] = 0; out[o + 3] = 255; } break;
      case FMT.A2B10G10R10: case FMT.A2R10G10B10: for (let x = 0; x < w; x++, s += 4, o += 4) { const v = u8[s] | (u8[s + 1] << 8) | (u8[s + 2] << 16) | (u8[s + 3] << 24); const r = (v & 1023) >> 2, g = ((v >> 10) & 1023) >> 2, b = ((v >> 20) & 1023) >> 2, a = ((v >>> 30) & 3) * 85; if (fmt === FMT.A2B10G10R10) { out[o] = r; out[o + 2] = b; } else { out[o] = b; out[o + 2] = r; } out[o + 1] = g; out[o + 3] = a; } break;
      default: for (let x = 0; x < w; x++, s += 4, o += 4) { out[o] = u8[s + 2]; out[o + 1] = u8[s + 1]; out[o + 2] = u8[s]; out[o + 3] = 255; }
    }
  }
  return out;
}

