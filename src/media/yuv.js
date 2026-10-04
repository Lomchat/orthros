// 4:2:0 Y'CbCr (ITU-R BT.601, studio range: Y' 16-235, Cb / Cr 16-240 around 128) -> RGBA bytes.

const FIX = 1 << 16;
const YT = new Int32Array(256), RV = new Int32Array(256), GU = new Int32Array(256), GV = new Int32Array(256), BU = new Int32Array(256);
for (let i = 0; i < 256; i++) {
  YT[i] = Math.round(1.164383 * (i - 16) * FIX) + FIX / 2; // (+ 1/2: rounding)
  RV[i] = Math.round(1.596027 * (i - 128) * FIX);
  GU[i] = Math.round(-0.391762 * (i - 128) * FIX);
  GV[i] = Math.round(-0.812968 * (i - 128) * FIX);
  BU[i] = Math.round(2.017232 * (i - 128) * FIX);
}
// clamping to 0..255 by table: (value >> 16) + OFF covers -19 - 258 .. 278 + 258
const OFF = 512, CL = new Uint8Array(1536);
for (let i = 0; i < CL.length; i++) CL[i] = Math.max(0, Math.min(255, i - OFF));
const LITTLE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * Convert the w x h rectangle at (x0, y0) (even) of a picture { y, cb, cr, stride, cstride } into `out` (RGBA,
 * w * h * 4 bytes, opaque).
 */
export function yuv420ToRgba(p, x0, y0, w, h, out) {
  const { y: Y, cb: U, cr: V, stride, cstride } = p;
  if (!LITTLE || out.byteOffset & 3) return slow(p, x0, y0, w, h, out);
  const o32 = new Uint32Array(out.buffer, out.byteOffset, w * h);
  let o = 0;
  for (let r = 0; r < h; r++) {
    const yr = (y0 + r) * stride + x0, cr = ((y0 + r) >> 1) * cstride + (x0 >> 1);
    for (let c = 0; c < w; c += 2) {
      const u = U[cr + (c >> 1)], v = V[cr + (c >> 1)];
      const rv = RV[v], guv = GU[u] + GV[v], bu = BU[u];
      let yy = YT[Y[yr + c]];
      o32[o++] = 0xff000000 | CL[((yy + bu) >> 16) + OFF] << 16 | CL[((yy + guv) >> 16) + OFF] << 8 | CL[((yy + rv) >> 16) + OFF];
      if (c + 1 < w) { yy = YT[Y[yr + c + 1]]; o32[o++] = 0xff000000 | CL[((yy + bu) >> 16) + OFF] << 16 | CL[((yy + guv) >> 16) + OFF] << 8 | CL[((yy + rv) >> 16) + OFF]; }
    }
  }
  return out;
}
function slow(p, x0, y0, w, h, out) {
  const { y: Y, cb: U, cr: V, stride, cstride } = p;
  let o = 0;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const x = x0 + c, ci = ((y0 + r) >> 1) * cstride + (x >> 1), yy = YT[Y[(y0 + r) * stride + x]], u = U[ci], v = V[ci];
      out[o] = CL[((yy + RV[v]) >> 16) + OFF]; out[o + 1] = CL[((yy + GU[u] + GV[v]) >> 16) + OFF]; out[o + 2] = CL[((yy + BU[u]) >> 16) + OFF]; out[o + 3] = 255;
      o += 4;
    }
  }
  return out;
}
