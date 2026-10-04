# Movie and sound file playback: DirectShow (quartz.dll)

Windows games of the DirectX 7-9 era play their movies — and often their music — with DirectShow. Vice City, for
instance (traced with `--log comx,video`), creates the filter graph manager and plays `movies\Logo.mpg` then
`movies\GTAtitles.mpg`:

```
CoCreateInstance(CLSID_FilterGraph e436ebb3-…, IID_IGraphBuilder 56a868a9-…)
IGraphBuilder::RenderFile(L"movies\\Logo.mpg")           (QueryInterface: IMediaControl, IMediaEventEx, IVideoWindow, IMediaSeeking)
IVideoWindow::put_Owner(game window), put_WindowStyle(WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN)
IMediaEventEx::SetNotifyWindow(game window, message 0x40d, 0)
IVideoWindow::SetWindowPosition(0, 0, 640, 480), put_MessageDrain(game window)
IMediaControl::Run()
  … the game's loop polls its input (a key or a click: IMediaControl::Stop, Release) and its messages:
  the notification message → IMediaEventEx::GetEvent → EC_COMPLETE → FreeEventParams → Stop, Release
```

Without DirectShow (before: `REGDB_E_CLASSNOTREG`) the game waited for a key on a black screen.

The formats are told apart by their content, as DirectShow's source filters do (an AVI named `.mpg` plays).

## What is implemented (src/win32/quartz.js)

The filter graph manager as an application sees it (`CLSID_FilterGraph`, `CLSID_FilterGraphNoThread`), one COM object
per interface sharing the graph (QueryInterface answers any of them):

- **IGraphBuilder / IFilterGraph(2)**: `RenderFile` (the path relative to the current directory, through the virtual
  file system); building graphs by hand (`AddFilter`, `Connect`, pins) is not available (`E_NOTIMPL`).
- **IMediaControl**: `Run`, `Pause` (the current picture shown), `Stop` (the position kept, as DirectShow does),
  `GetState`, `RenderFile`.
- **IMediaEvent / IMediaEventEx**: an event queue (`EC_COMPLETE` once every stream has ended, `EC_ERRORABORT` on a read
  failure), a manual-reset event handle signaled while events are queued (`GetEventHandle`), `GetEvent` with a timeout,
  `WaitForCompletion`, the notification message posted to the `SetNotifyWindow` window per event.
- **IMediaSeeking / IMediaPosition**: duration, current / stop positions, absolute and relative seeking (backward:
  decoders restarted from the beginning), rate 1 only.
- **IVideoWindow / IBasicVideo(2)**: the video window's owner, style, position, visibility (`AutoShow`: shown on
  Run / Pause), full-screen mode, source and destination rectangles, video size. Without a video stream these methods
  answer `E_NOINTERFACE`, as the filter graph manager does without a video renderer.
- **IBasicAudio**: volume and balance (1/100 dB), applied to the sound stream.

Files that cannot be played get the results of a Windows lacking the codec, so that games skip the movie as before:
`HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)`, `VFW_E_UNKNOWN_FILE_TYPE` (not a recognized format),
`VFW_E_UNSUPPORTED_STREAM` (MPEG audio layer III with no decoder), `VFW_S_AUDIO_NOT_RENDERED` (video with a sound stream
that cannot be decoded: the video plays silent). A graph run without anything rendered (a game ignoring RenderFile's
failure) completes at once (`EC_COMPLETE`): a movie of no length.

## Formats (src/media)

What Windows plays with its own splitters and codecs (no codec pack installed). Chrome decodes none of the video and
few of the audio formats, so most are decoded here, written from the standards; the rest goes to the browser:

| file | streams | decoded by |
|---|---|---|
| MPEG-1 system stream (`.mpg`; MPEG-2 program stream pack headers accepted) | MPEG-1 video, MPEG audio | `mpeg-ps.js` + below |
| MPEG-1 video elementary stream (`.m1v`) | I / P / B / D pictures | `mpeg1-video.js` |
| MPEG audio (`.mp2`, `.mp3`, `.mpa`; also inside a WAVE file, format 0x50 / 0x55) | layers I, II | `mpeg-audio.js` |
| | layer III (MP3) | the browser: WebCodecs `AudioDecoder` (asynchronous: `AsyncAudio`) |
| RIFF WAVE (`.wav`) | PCM 8-32 bit, float, extensible, IMA ADPCM, Microsoft ADPCM | `wav-source.js` |
| AVI (`.avi`) | video: uncompressed DIB (1-32 bit), Microsoft RLE (RLE8 / RLE4), Microsoft Video 1 (16-bit), Cinepak | `avi-source.js`, `vfw-codecs.js` |
| | sound: as in WAVE files, MPEG audio | `wav-source.js`, `mpeg-audio.js` / the browser |

- `mpeg-ps.js`: demultiplexer (packs, PES packets with MPEG-1 or MPEG-2 headers, time stamps), incremental.
- `mpeg1-video.js`: half-pel motion compensation with edge extension, quantizer matrices, the inverse DCT in double
  precision (even / odd butterflies; equal to the definition up to the rounding of exact halves).
- `mpeg-audio.js`: layers I and II (all bit allocation tables, MPEG-2 low sampling frequencies, intensity stereo),
  polyphase synthesis. The synthesis window (`mpeg-audio-window.js`, a constant of the standard, table B.3) was
  recovered by `tools/mpa-window-fit.mjs`: the decoder's output is linear in the 512 window values, so a least-squares
  fit against a reference decoding gives them; every value lands within 0.07 units of a multiple of 2^-16 (the table's
  unit) and the halves mirror each other as the standard says.
- `mpeg-source.js`: a file being played: read ahead in 256 KiB chunks (asynchronously when the range is still on the
  network: `file.prepare`), pictures and sound decoded on demand for a stream time; a caller late by more than one
  picture has the B pictures in between dropped undecoded. Layer III frames go to the browser's decoder 1 s ahead of
  the time asked. The duration: from the time stamps of the first and last packs, the VBR header (Xing / Info, VBRI) of
  an MP3, or the bit rate.
- `wav-source.js`: WAVE chunks, PCM and ADPCM blocks. IMA ADPCM follows the reference algorithm's step arithmetic.
- `yuv.js`: BT.601 studio-range Y'CbCr 4:2:0 → RGBA (when the host cannot take the planes itself).
- `avi-source.js`: the header list (first video and audio streams; a stream without a decoder is left out:
  `VFW_S_VIDEO_NOT_RENDERED` / `VFW_S_AUDIO_NOT_RENDERED`, as the filter graph manager answers when some streams
  cannot be rendered), the `movi` chunks parsed as they are read (`rec ` lists, palette changes), every frame decoded in
  order (the codecs' frames depend on the previous picture).
- `vfw-codecs.js`: the Video for Windows decoders Windows ships with, drawing into a persistent RGBA frame: DIBs with
  palettes, RLE8 / RLE4 (deltas, absolute runs), Microsoft Video 1 (skip / 1 / 2 / 8-color 4x4 blocks), Cinepak (strips,
  V1 / V4 codebooks with partial updates and inheritance, intra / inter / V1-only vectors, gray codebooks). Indeo,
  MPEG-4 or WMV video are not decoded (a codec Windows XP may have, through other components).

Accuracy (tests/media-mpeg.test.js, media-audio-files.test.js, media-avi.test.js against ffmpeg's decoders): AVI video
exact (RLE, DIB, gray Cinepak) or within 1 per component (the 5-bit expansion of 5-5-5 colors, Cinepak's color
conversion rounding); MPEG-1 video 45-66 dB PSNR per
picture (only the inverse DCT's rounding differs from ffmpeg's integer transform), layer I / II > 100 dB SNR, PCM and
Microsoft ADPCM exact, IMA ADPCM ~44 dB (ffmpeg computes the step product otherwise); MP3 through WebCodecs in Chromium
118 dB against ffmpeg (tools/media-browser-check.mjs; the browser's decoder, like Windows', plays the encoder delay and
the LAME header frame that ffmpeg drops).

## Output

- **Pictures**: the host display's video layer (`#vid` on the page, a display-sized transparent layer above the GDI
  and Direct3D layers), the picture stretched to the video window's rectangle — the owner's client area plus the
  window's position for a child window, the destination rectangle inside it — as the video renderer's window covers
  the game's. In the browser the decoded planes become a WebCodecs `VideoFrame` drawn on the layer
  (`BrowserDisplay.presentVideoYuv`: the color conversion and scaling are the canvas's); without VideoFrame (or with
  `?dbg=ORTHROS_VIDEO_RGBA=1`) `yuv.js` converts them and `presentVideo` draws the RGBA picture. The layer is hidden
  when the window is hidden or the graph released. Input goes to the game's window (the video window is not a real
  window: the message drain games set is where it would go anyway).
- **Sound**: a stream voice of the DirectSound mixer (`dsound.js createAudioStream`): a looping 16-bit ring in guest
  memory mixed by the AudioWorklet like any DirectSound buffer; the graph writes the decoded samples 250 ms ahead of the
  play cursor, both following the VM clock, so pictures and sound stay together.
- **Clock**: the VM clock. `vm.media` (MediaClock) is advanced by the scheduler at its wake-up passes
  (`Sched.wakeBlocked`) and asks it to wake up for the next picture or sound refill (`Sched.nextWake`): playback goes on
  while the game's threads wait (`WaitForCompletion`, a message wait, `Sleep`).

Logs: `--log video` (RenderFile, Run, completion and release with statistics: pictures shown, decoded then overtaken,
B pictures skipped, decoding and showing time per picture on the game's worker, lateness).

## Measured (Vice City, headless Chromium with SwiftShader on the shared server)

`movies\Logo.mpg`: 640x480, 25 fps, 48 kHz stereo layer II, 39.5 s. Every run: 987 pictures, all shown (none dropped
or skipped), lateness at most 10-16 ms, 39.48 s of sound mixed (no underrun). On the game's worker, per picture:

| presentation (2 runs each, alternated) | decoding | showing |
|---|---|---|
| RGBA conversion here (`?dbg=ORTHROS_VIDEO_RGBA=1`) | 2.9, 2.7 ms | 2.4, 2.3 ms |
| WebCodecs VideoFrame (default) | 2.5, 3.2 ms | 0.3, 0.6 ms |

The movies can be skipped (a key or a click: the game stops and releases the
graph, the layer disappears) and the game goes on to its main menu.
