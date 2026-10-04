// A small AVI written for the tests (media-avi.test.js, quartz.test.js).
/** RIFF chunk / list writers */
const le32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255], le16 = (v) => [v & 255, (v >> 8) & 255];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const chunk = (id, data) => { const d = [...data]; return [...ascii(id), ...le32(d.length), ...d, ...(d.length & 1 ? [0] : [])]; };
const list = (type, items) => { const d = [...ascii(type), ...items.flat()]; return [...ascii('LIST'), ...le32(d.length), ...d]; };

/** an AVI: W x H 8-bit paletted frames (bottom-up), 8 kHz mono 16-bit PCM, a palette change at frame 2, 'rec ' lists */
export function makeAvi(W, H, nframes, fps) {
  const pal = Array.from({ length: 256 }, (_, i) => [i, 255 - i, (i * 7) & 255, 0]).flat();
  const bih = [...le32(40), ...le32(W), ...le32(H), ...le16(1), ...le16(8), ...le32(0), ...le32(0), ...le32(0), ...le32(0), ...le32(256), ...le32(0), ...pal];
  const wfx = [...le16(1), ...le16(1), ...le32(8000), ...le32(16000), ...le16(2), ...le16(16)];
  const strh = (type, handler, scale, rate, length, sampleSize) => [...ascii(type), ...ascii(handler), ...le32(0), ...le32(0), ...le32(0), ...le32(scale), ...le32(rate), ...le32(0), ...le32(length), ...le32(0), ...le32(0xffffffff), ...le32(sampleSize), 0, 0, 0, 0, 0, 0, 0, 0];
  const avih = [...le32(Math.round(1e6 / fps)), ...le32(0), ...le32(0), ...le32(0x10), ...le32(nframes), ...le32(0), ...le32(2), ...le32(0), ...le32(W), ...le32(H), ...le32(0), ...le32(0), ...le32(0), ...le32(0)];
  const hdrl = list('hdrl', [chunk('avih', avih), list('strl', [chunk('strh', strh('vids', '\0\0\0\0', 1, fps, nframes, 0)), chunk('strf', bih)]), list('strl', [chunk('strh', strh('auds', '\0\0\0\0', 1, 8000, nframes * 8000 / fps, 2)), chunk('strf', wfx)])]);
  const frames = [], sound = [], items = [];
  const spf = 8000 / fps;
  for (let f = 0; f < nframes; f++) {
    const px = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = (x * 3 + y * 5 + f * 11) & 255; // (stored rows: bottom-up)
    px[0] = 0; px[1] = 1; // (the entries the palette change replaces)
    frames.push(px);
    const pcm = new Int16Array(spf); for (let i = 0; i < spf; i++) pcm[i] = ((f * spf + i) * 37 % 2000) - 1000;
    sound.push(pcm);
    const rec = [chunk('01wb', new Uint8Array(pcm.buffer)), chunk('00db', px)];
    if (f === 2) rec.unshift(chunk('00pc', [0, 2, 0, 0, 10, 20, 30, 0, 40, 50, 60, 0])); // (entries 0-1 change)
    items.push(f % 2 ? list('rec ', rec) : rec.flat());
  }
  const movi = list('movi', items);
  const body = [...ascii('AVI '), ...hdrl, ...chunk('JUNK', new Uint8Array(30)), ...movi, ...chunk('idx1', new Uint8Array(16))];
  return { bytes: new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body]), frames, sound, pal };
}
