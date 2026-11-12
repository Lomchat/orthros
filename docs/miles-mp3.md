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

**Result**: the sound is the same as the original's (61-77 dB from a file's start), and the guest instructions in
play drop by 6-13 %. Thread time does not drop beyond the measurements' spread: the decoder was 1-2 % of RotWK's
thread, and its instructions are cheap. **Off by default**, `?dbg=ORTHROS_MP3_HOST=1` to turn it on.

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
- `seek(-2)`: mss32 has moved its source on its own (a stream looping, its buffers loaded again). The original
  clears its decoder's state, keeps the rest of the frame it was reading out, and reads on from the source, whose
  next bytes are the new ones. Here the rest of that frame is kept (copied out of the ring when it is already
  decoded). What was fetched, parsed or decoded ahead is dropped, and a new session reads on with `fetch(-1)`. Any
  other offset drops everything and reads from that offset.
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
- unset or `0`: the guest's decoder (the default, `HOST_DEFAULT`: see "Decision" below);
- `1`: the host's decoder where one exists: the page when it is cross-origin isolated and WebCodecs decodes mp3
  (src/web/worker.js creates the helper then), Node through startbench `--mp3-host` (ffmpeg). Elsewhere the guest's;
- `trace`: the guest's decoder, every call logged (`ORTHROS_MP3_LOG=1`: opens, closes, seeks, short reads in both
  modes; `ORTHROS_MP3_TRACE_ATTR=1`: attribute queries; `ORTHROS_MP3_TRACE_PROCESS=1`: every `process` call and the
  unusual `fetch` calls). `startbench --mp3-capture <dir>` writes each stream's MP3 input and PCM output there, for
  `tools/dev/mp3-compare.mjs`.
- `ORTHROS_MP3_PRINT=1`: the fingerprint of every Miles provider loaded, and the entries it registers.
- `tools/bench/ab-virtual.mjs --variant-env on='ORTHROS_MP3_HOST=1'` compares the two, as measured below.

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

**Where the decoder's time goes.** A V8 CPU profile of RotWK play (Node, the guest's decoder, 80 s of
`rotwk-quick` play) puts mssmp3.asi's translated code at 0.93 s: 1.2 % of the emulator thread, or 2.2 % of its time
not spent waiting. The decoder runs many guest instructions (the mixer thread's 2.76 G of a 25.5 G run, 2.48 G of
them in 120 s of play), but cheap ones: straight-line floating-point code at roughly 0.3-0.4 ns per instruction,
against 2.3 ns for the game's average. The study's "7.5-13 % of instructions" is therefore 1-2 % of the time in
RotWK. AotR decodes about as much in the same scenario length (below).

**Guest instructions per frame in play**, with and without the host decoder:

| game, run | guest decoder | host decoder | change |
|---|---|---|---|
| RotWK 2.02 `rotwk-short`, virtual clock (2 runs each) | 5.97 M | 5.20 M | −12.9 % |
| BFME II 1.09 `bfme2-short`, virtual clock (2 runs each) | 4.36 M | 4.06 M | −6.9 % |
| AotR 10 `learn-aotr-skirmish` + 60 s, real clock, play2 (30 s, ~900 frames), two pairs | 7.71 / 9.08 M | 6.78 / 7.87 M | −12.1 / −13.4 % |
| Vice City `vc-quick` drive, real clock (one run each) | 5.76 M | 5.40 M | −6.3 % |

The mixer thread's instructions: RotWK 2 764 → 283 M, BFME II 5 849 → 724 M (`rotwk-quick` / `bfme2-quick`,
`--threads`).

**The emulator thread's CPU per frame** (Node). Under `ab-virtual` the two variants run at the same time, two runs
each, with the same game work. The thread's CPU time per frame of each phase, in ms (each run's value in brackets):

| game, phase | guest decoder | host decoder | change |
|---|---|---|---|
| RotWK play, round 1 | 15.44 [15.19 15.69] | 15.31 [15.50 15.13] | −0.8 % |
| RotWK play, round 2 | 18.03 [18.07 17.99] | 18.13 [18.20 18.06] | +0.6 % |
| RotWK menu, rounds 1 / 2 | 9.15 / 10.48 | 8.78 / 10.43 | −4.1 / −0.4 % |
| BFME II play | 12.52 [12.54 12.50] | 12.12 [11.99 12.26] | −3.2 % |
| BFME II menu | 7.11 [7.58 6.64] | 6.24 [6.37 6.12] | −12.2 % |
| AotR play (real clock, two concurrent pairs, 790-875 frames) | 20.0 / 25.4 | 18.9 / 25.5 | −5.5 / +0.4 % |
| AotR play2 (the same runs, 894-903 frames) | 17.9 / 19.6 | 17.8 / 20.3 | −0.8 / +3.6 % |

- **Load screens**: the phase ends at a point in virtual time. The host variant does less guest work, so it shows
  fewer frames in that phase, and its CPU per frame looks higher (RotWK +19.7 / +21.9 %, BFME II +4.4 %) while the
  phase as a whole costs less: RotWK 9.2 → 8.9 s, BFME II 10.5 → 10.1 s of thread CPU.
- **The host side's own cost in Node**: `__mss_ASI_stream_process` takes 0.06-0.10 ms per frame (8 calls of 7-12 µs).
  This includes the waits for ffmpeg at each stream's start (5-16 per run, 158-278 ms in all), which the browser
  does not have (below).
- **Messages**: the first version sent one message per MP3 frame. A profile of RotWK play then put 1.96 s of 80 s in
  `postMessage` (1.26 ms per frame for `__mss_ASI_stream_process`). With messages batched (one per ~0.17 s of
  sound per stream), that cost is gone from the profile's top.

**Browser** (Chromium headless shell through the slot guard, pinned to its 4 cores, `--gl-discard`, RotWK
`rotwk-quick`, `--audio`; single runs, guest decoder and host decoder alternated):
- The sound plays: the AudioWorklet runs, output peak 0.33 (0.28 with the guest's decoder), no underruns. 8 MP3
  sessions (menu music, then voices and music in play), 6 096 frames decoded by the helper, 0 failures. The game's
  thread waited for decoded PCM 15 times in the whole run, 11 ms in all.
- Frame accounting, ms per frame (guest + API categories), and fps:

| run (machine load) | menu guest + api | play guest | play api | play guest + api | play fps |
|---|---|---|---|---|---|
| guest decoder (13:30, load ~25-30) | 14.3 | 18.7 | 3.6 | 22.3 | 25.5 |
| host decoder (13:40, load ~14-18) | 10.7 | 16.5 | 3.0 | 19.5 | 27.1 |
| guest decoder (13:45, load ~8-12) | 10.3 | 16.9 | 2.9 | 19.8 | 27.1 |
| host decoder, final code, `?dbg=ORTHROS_MP3_HOST=1` (14:06, load ~8-12) | 10.3 | 16.1 | 3.0 | 19.1 | 27.1 |

  Against the guest-decoder run at 13:45, the host runs are −1.5 % and −3.5 % in play, and +3.9 % and 0 % in the
  menu. That is within the spread of single runs, but it leans the host's way. A first host run with one message
  per frame (13:15, load 30-39) had 20.6 + 4.4 ms in play. The final run: 6 sessions, 6 661 frames, 21 waits
  (18 ms), 0 failures, output peak 0.22.

**AotR.** Under `--virtual`, AotR never got past the launcher's first frames in 25 minutes, so its pairs were run
on the real clock, both variants at once, and only their play phases with about the same frame counts are
compared. An earlier version gave 9.16 → 6.55 M instructions and 20.3 → 17.0 ms of CPU per frame (−16 %) in one
pair. Two pairs of the final version (above) do not repeat that gain. Their sessions decoded 9 400-9 600 MP3 frames;
runs that went 6 minutes further into the skirmish decoded 26 600-28 300.

In three runs of intermediate versions, the scenario's anchor (the first frame with 400 draws) came about 5 minutes
late. In two of them, `seek(-2)` kept the bytes fetched ahead, which plays stale input after mss32 has moved its
source; the third was stopped after a minute. docs/jit-code-shape.md reports that this anchor also flakes with the
guest's decoder. With the final code, the three host runs met it on time: load screen 11.9, 15.3 and 12.0 s, against
11.3, 14.1 and 11.0 s for the guest runs started with them. One of those host runs logged its events: the same
opens and attribute queries as the guest's decoder.

**Decision: off by default** (`HOST_DEFAULT = 0`; `?dbg=ORTHROS_MP3_HOST=1` turns it on in the page,
`startbench --mp3-host` in Node). The rule for a default is a win beyond noise on at least two games and a loss on
none. Here, 6-13 % fewer guest instructions in play give, in thread CPU per frame, −0.8 / +0.6 % on RotWK (Node,
two deterministic rounds), −3.2 % on BFME II (one round), −5.5 / +0.4 % and −0.8 / +3.6 % on AotR (two real-clock
pairs), and −1.5 / −3.5 % on RotWK in the browser (two host runs against one guest run). Only BFME II's result is
beyond its spread.
The decoder's instructions are among the game's cheapest (high-IPC floating-point code), and the host side costs
some of what it saves (messages, copies, `fetch` calls through the guest). What stays in favour of the host path:
the decoding leaves the game's thread entirely, which matters more where the decoder's share is larger (many
streams at once), and the sound is the same (above). It is ready to be turned on if a measurement on the target
machine shows a gain.

## Not done / open

- **Verified in a browser on RotWK only.** BFME II, AotR and Vice City were run in Node (the ffmpeg stand-in): they
  decode with 0 failures (Vice City: 115 sessions, 110 streams opened, 5 restarted at the first read).
- **Snapshots holding host streams** follow the design above (frames not heard are kept and sent again), but no game
  snapshot was taken and restored with streams open. `tools/check/snapshot-check.mjs` runs Node without
  `--mp3-host`. Off by default, production snapshots (Chrome, at a menu, its music playing) hold none; turning it on
  should come with a snapshot check.
- **A session that fails** (a helper error, or 3 s without PCM) leaves its stream silent until the game opens it
  again. The guest's decoder is not used as a fallback for that stream, because its input has already been read.
- **Preferences** (Requested sample rate / bit width / channels) are stored and reported, never applied. The
  original's output attributes also report the file's own format.
- **Other Miles versions** keep the guest's decoder. Adding one means adding its fingerprint, after checking that its
  stream functions take the same arguments (a trace with `ORTHROS_MP3_HOST=trace`).
- **The game's thread can still wait** for PCM the helper has not decoded yet: at a stream's start, or when the
  reader catches up with the decoder. That happened 15 times in a RotWK browser run, 11 ms in all.
- **mss32's calls are recorded, not documented**: the semantics above come from traces of RotWK (MSS 7) and from
  reading the two providers' stream functions (MSS 6 matches MSS 7 there). A behaviour the traces did not meet
  (for example a seek to a non-zero offset) follows the original's code as read, untested.
