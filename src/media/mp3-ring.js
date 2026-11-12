// The shared ring of an MP3 decoding session (src/media/mp3-host.js writes MP3 frames to the helper, src/media/mp3-helper.js
// writes PCM here): a header of Int32 words, then the PCM bytes (16-bit interleaved), positions counted in bytes since the
// session's start (index = position % capacity).
/** header bytes */
export const RING_HDR = 64;
/** header words: bytes written (helper), bytes read (emulator), state, a counter bumped (and notified) at every change */
export const H_W = 0, H_R = 1, H_STATE = 2, H_SEQ = 3;
/** states: decoding; done (every sample of the session written: the 'end' total); failed */
export const ST_RUN = 0, ST_DONE = 1, ST_FAILED = 2;
