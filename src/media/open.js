// The media files the DirectShow path plays (quartz.js RenderFile): the source for a file, by its first bytes.
import { MpegSource, MediaError, HEAD } from './mpeg-source.js';
import { WavSource, isWave, parseWave, isMpegWaveTag, subFile } from './wav-source.js';
import { AviSource, isAvi } from './avi-source.js';

/**
 * @param {{ size: () => number, read: (off: number, len: number) => Uint8Array, prepare?: (off: number, len: number) => Promise<any>|null, close?: () => void }} file
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {MpegSource|WavSource|AviSource} (throws MediaError: 'unsupported' / 'corrupt')
 */
export function openMedia(file, opts = {}) {
  const head = file.read(0, Math.min(file.size(), HEAD));
  if (!head.length) throw new MediaError('corrupt', 'empty file');
  if (isAvi(head)) return new AviSource(file, head, opts);
  if (isWave(head)) {
    const w = parseWave(file, head);
    // (MPEG audio in a WAVE file — format 0x50 / 0x55, what Windows' ACM decodes: its data chunk played as an MPEG stream)
    if (isMpegWaveTag(w.fmt.tag)) return new MpegSource(subFile(file, w.dataStart, w.dataSize), opts);
    return new WavSource(file, head, opts);
  }
  return new MpegSource(file, opts, head);
}
export { MediaError };
