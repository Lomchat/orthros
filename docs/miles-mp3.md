# Miles' MP3 decoder run by the host (2026-11-12, D122)

Games built on the Miles Sound System decode their MP3 (music, voices, ambient sounds) in an **ASI codec provider**, a
DLL that mss32.dll loads from its redist folder: `mssmp3.asi` (MSS 7: BFME, BFME II, RotWK, Age of the Ring — the same
file in all four) or `Mp3dec.asi` (MSS 6: Vice City). Its decoding is x87 code run on Miles' mixer thread. The
2026-11-12 study counted it at 7.5-13 % of the guest instructions in SAGE play (data/proof/guest-speed-2026-11-12).
The owner allowed recognising such a library by its content and accepted a decoder whose output differs from the
original as long as it sounds the same (DECISIONS.md D122).

With the host decoder on, the provider's stream functions are the host's (src/win32/miles-mp3.js). The MP3 frames go
to the browser's WebCodecs `AudioDecoder` in a helper worker (src/media/mp3-helper.js), and the game's thread only
copies the PCM back (src/media/mp3-host.js, src/media/mp3-ring.js).

## The ASI interface, as mss32 uses it

An ASI provider registers two RIB interfaces with mss32's `RIB_register_interface(provider, name, count, entries)`
(stdcall). Each entry is 16 bytes: type (0 function, 1 attribute, 2 preference), name, value (an address or a token),
subtype. The registration happens from `RIB_Main` (MSS 7, which mss32 calls after loading the DLL) or from `DllMain`
(MSS 6). Both import `RIB_register_interface` from mss32.

- **"ASI codec"**: `PROVIDER_query_attribute` and its attributes (Name, Version, Input file types `*.MP3`, ...),
  `ASI_startup`, `ASI_error`, `ASI_shutdown`.
- **"ASI stream"**: `ASI_stream_open(user, fetch, total) → stream` (3 arguments), `ASI_stream_process(stream, buffer,
  bytes) → bytes` (3), `ASI_stream_attribute(stream, token) → value` (2), `ASI_stream_set_preference(stream, token,
  &value) → previous` (3), `ASI_stream_seek(stream, position)` (2), `ASI_stream_close(stream)` (1), all stdcall.
  Attributes by token: Input / Output bit rate, sample rate, sample width, channels, Position, Percent done (a float's
  bits), Minimum input block size, MPEG version, MPEG layer. Preferences: Requested sample rate / bit width / # of
  channels (stored and reported, never applied).

The decoder pulls its input through mss32's callback `fetch(user, dest, bytes, offset) → bytes read` (stdcall).
`offset` -1 means where the last read ended; any other value repositions within mss32's current buffer. In RotWK the
callback copies from the sample's buffers (mss32+0x2c020): a whole file for a sound in memory, two halves refilled
from the file for a streamed one. A short read means the data is not there yet (a half not refilled), or the end.

What a trace of the original shows (RotWK, `ORTHROS_MP3_HOST=trace`, `ORTHROS_MP3_TRACE_PROCESS=1`):
- `open` reads from offset 0 until the first frame header, searching at most 4 KiB, and returns 0 if it finds none.
  mss32 opens again later in that case (the data had not arrived). The first `process` reads from offset 0 again.
- `process` is called by the mixer thread, and sometimes by the main thread, with 1 400-1 600 bytes (about 8 ms at
  44.1 kHz stereo). It returns that many bytes until the input ends. The last call returns fewer, with the rest of the
  buffer set to zero, and mss32 then closes the stream.
- `seek(-2)` (music streams): the decoder's state is reset (bit reservoir, synthesis memory), the PCM left from the
  frame being read is kept, and reading goes on where the source is (`fetch` with -1). Any other value resets
  everything and reads from that offset.
- Output: 16-bit interleaved PCM at the stream's own rate and channel count. Layer III only (layers I and II are
  refused at `open`).

## Recognition and interception

- `codeFingerprint(img)`: FNV-1a over the raw bytes of the file's executable sections, with their length. Only the
  fingerprints ship (`KNOWN_DECODERS`). `?dbg=ORTHROS_MP3_PRINT=1` logs the fingerprint of every provider that
  imports `RIB_register_interface`.
- The loader's import resolution (Process.resolveImports → `vm.milesImport`) gives a recognised decoder the host's
  `RIB_register_interface` (orthros.dll `__mss_RIB_register_interface`). That function replaces, in the entries, the
  addresses of the six stream functions with host thunks, records the tokens of the "ASI stream" attributes by name,
  and tail-calls mss32's own `RIB_register_interface`. Everything else stays the provider's own: DllMain, `RIB_Main`,
  startup, shutdown, error text, `PROVIDER_query_attribute`. The game files are untouched.
- The decision is made when the provider loads, so a stream is either the guest's or the host's from start to end:
  host decoding needs a decoder (`vm.host.mp3`) at that moment.

## The host streams (src/win32/miles-mp3.js)

- `open` reads 4 KiB through `fetch` from offset 0 and looks for a Layer III header in it. With no header it
  returns 0, as the original does. Otherwise it returns an opaque handle and starts decoding at once: the bytes
  already read are parsed into frames and sent.
- Frames are found by their header (sync, Layer III, the first header's version and sample rate) and their length.
  The bytes that follow are kept until the frame is whole. When the reader is not yet in step with the stream (at its
  start, or after bytes that are not a frame), a header counts only if another one follows it: the 11 sync bits also
  occur inside frame data.
- A session that starts in the middle of a stream (a buffer switched since `open`, a seek, a restored machine) cannot
  decode its first frames when their `main_data_begin` points into the bit reservoir of earlier frames it never
  received. The original skips them: its output starts one or two frames later. Here they are still sent to the
  decoder (it keeps their data for the frames that follow), but their PCM is skipped when read.
- **Ahead of the reader**: frames are sent while the PCM sent and not yet read stays under 0.35 s and fits the ring.
  Nothing is sent until half of that has been read, so each stream costs about 6 messages per second, not one per
  frame. `fetch` is called again (4 KiB at a time, at most twice per `process` call) when no parsed frames are left.
- `process` copies from the ring. It waits on the ring (Atomics.wait, at most 3 s, then the stream is given up and
  stays silent) only when the PCM it needs has been sent and is not decoded yet. When nothing is left to read, it
  fetches once more. If that brings nothing, the session is told its end: the decoder flushes, the rest is padded to
  the frames' total, and the call returns what remained, with the rest of the buffer zeroed. If the source refills
  later (a streamed half), a new session continues from the new data.
- The first `process` call reads the start again from offset 0, as the original does. mss32's offsets are within its
  current buffer, and a streamed sample may have loaded or switched it since `open`. If the bytes are the same, the
  session started at `open` goes on. If not, it is dropped and decoding starts from the bytes there now.
- `seek(-2)` resets the decoder's state and keeps reading where it is: every byte fetched is kept, and the frames not
  yet read are decoded again by a new session (the original keeps the rest of its decoded frame and parses on from its
  input position). Any other offset drops everything and reads from that offset.
- The attributes are computed from the headers, as the original computes them: Position is the input offset after
  the frame being read, Percent done is `float(position) * 100 / total`, and Input sample width is
  `16 / max(1, rate * channels * 16 / bitrate)`.
- Snapshots: an `Mp3Stream` (registered class `mss.Mp3Stream`) holds everything the guest gave and the MP3 bytes not
  yet heard: frames sent and not wholly read, frames parsed, bytes after them. Only the decoder session is the
  host's (`skip: ['session']`). A restored machine sends the unread frames to a new session and drops what had been
  read of the first one. Frames that cannot be decoded without the bit reservoir are skipped, as above.

## The helper and its ring (src/media/mp3-helper.js, mp3-host.js, mp3-ring.js)

- One helper worker per page (`host.mp3`, created by src/web/worker.js when the page is cross-origin isolated and
  `AudioDecoder.isConfigSupported({ codec: 'mp3' })` says yes). Each session gets its own `SharedArrayBuffer`: a
  header (bytes written, bytes read, state, a change counter for Atomics.wait/notify) and 192 KiB of PCM.
- The emulator posts `open` / `data` (frames with their first sample's index) / `end` (the session's total) /
  `close`. The helper never posts anything back except failure messages. It writes PCM into the ring, and the
  emulator reads it without any message.
- **Placement by time**: each frame is decoded with its first sample's time stamp, and each output is written at its
  own position. Samples a decoder drops or delays (priming) become zeros at their place, and nothing is shifted. An
  output that overlaps what was already written is written once. The session's length is exactly the frames' total.
  tests/mp3-host.test.js checks this, and the ring wrapping under a reader, with the helper's `pcm-test` codec.
- Node has no WebCodecs. For measurements only, `startbench --mp3-host` (or `ORTHROS_MP3_HOST=1`) runs the same
  helper in a worker thread with one ffmpeg process per session (`-probesize 32 -analyzeduration 0 -fflags nobuffer`;
  without these flags ffmpeg waits for about 32 KiB of input before producing anything). ffmpeg takes no time
  stamps, so its output is placed in order. It drops the first frame of a LAME-tagged file, which leaves those
  streams one frame (1 152 samples) early. This path is not shipped.

## Switch

`ORTHROS_MP3_HOST` (debug global `?dbg=ORTHROS_MP3_HOST=…`, or the environment in Node):
- unset: host decoding where a decoder exists (the browser with WebCodecs' mp3), the guest's decoder elsewhere;
- `0`: always the guest's decoder;
- `1`: host decoding (Node: with ffmpeg, through startbench `--mp3-host`);
- `trace`: the guest's decoder, every call logged (`ORTHROS_MP3_TRACE_PROCESS=1`: `process` and unusual `fetch` calls
  too). `startbench --mp3-capture <dir>` writes each stream's MP3 input and PCM output there, for
  `tools/dev/mp3-compare.mjs`.

## Is the sound the same? (tools/dev/mp3-compare.mjs)

`startbench <version> --bench <bench> --mp3-capture <dir>` records every stream as the guest decoder decoded it:
its MP3 input, as fetched since the decoder's last read from offset 0, and its PCM output. `mp3-compare.mjs <dir>
--browser` decodes the same input again through the shipped path (Mp3Host and the helper with WebCodecs, in a
Chromium page) and compares the two: lengths, the lag that aligns them best (whole frames tried first), the
signal-to-error ratio over the aligned samples (per second with `--blocks`), and the largest difference (16-bit
units). The comparison covers 22 streams: two RotWK 2.02 captures (`rotwk-quick`: menu music, then two minutes of
play with music, voices and sounds; 15 streams with output) and one Vice City capture (`vc-quick`: cutscene and drive,
mp3dec.asi from MSS 6; 7 streams).

| | streams | lag | signal / error | largest difference |
|---|---|---|---|---|
| RotWK, from the file's start | 13 | 0 | 61.7-77.3 dB | 5-99 |
| RotWK, joined mid-file (stream 8: 1.3 s, stream 11: 0.2 s) | 2 | 0 | 22.3 dB (21 in the first second, 49 after), 11.5 dB | 597, 679 |
| Vice City | 3 | 0 | 54.1-67.1 dB | 1-299 |
| Vice City, a clip of 4 silent frames | 1 | — | identical | 0 |
| Vice City | 3 | 0 | 30.8, 39.8, 40.7 dB (per second 31-46) | 17 422, 6 860, 2 358 |

- **Length**: where the game played a stream to its end (RotWK 1 and 9, Vice City 104 and 107), the host gives
  exactly the guest's sample count. Every other stream was stopped by the game earlier (closed while playing), so
  the guest's output is shorter there.
- **Joined mid-file**: some streams start in the middle of the file (a buffer switched between `open` and the first
  `process` call). The original then skips the first frames, whose data begins in the bit reservoir of bytes it never
  read (1 or 2 frames: the guest's output starts 1 152 or 2 304 samples later). The host skips them too: their
  `main_data_begin` is larger than the main data the session has received so far. They are still sent to the
  decoder for their data, but their PCM is not read. Before this rule the lag was 1 152 / 2 304 on every such
  stream. Right after the join, the two decoders still differ for about a second (or for the whole of a 0.2 s
  clip), then they converge (49 dB).
- **Vice City's decoder** (MSS 6) is further from WebCodecs' than MSS 7's: three streams are at 31-46 dB per second.
  The differences are spread over the whole stream, about 35-40 dB under the signal. That is below the MP3 coding
  noise itself, and it does not shift the timing.
- The Node stand-in (ffmpeg) compares at 42-77 dB on the RotWK streams, with a lag of −1 152: ffmpeg drops the first
  frame, and its output has no time stamps to place it by. Players never use this path.

## What it saves

RESULTS_PERF

## Not done / open

OPEN_ITEMS
