# Movie playback: DirectShow (quartz.dll)

Windows games of the DirectX 7-9 era play their movies with DirectShow: Vice City, for instance (traced with
`--log comx,video`), creates the filter graph manager and plays `movies\Logo.mpg` then `movies\GTAtitles.mpg`:

```
CoCreateInstance(CLSID_FilterGraph e436ebb3-…, IID_IGraphBuilder 56a868a9-…)
IGraphBuilder::RenderFile(L"movies\\Logo.mpg")           (QueryInterface: IMediaControl, IMediaEventEx, IVideoWindow, IMediaSeeking)
IVideoWindow::put_Owner(game window), put_WindowStyle(WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN)
IMediaEventEx::SetNotifyWindow(game window, WM_APP-like message, 0)
IVideoWindow::SetWindowPosition(0, 0, 640, 480), put_MessageDrain(game window)
IMediaControl::Run()
  … the game's loop polls its input (a key or a click: IMediaControl::Stop, Release) and its messages:
  the notification message → IMediaEventEx::GetEvent → EC_COMPLETE → FreeEventParams → Stop, Release
```

Without DirectShow (before: `REGDB_E_CLASSNOTREG`) the game waited for a key on a black screen.

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

Results for files that cannot be played are those of a Windows lacking the codec, so that games skip the movie as before:
`HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)`, `VFW_E_UNKNOWN_FILE_TYPE` (not a recognized stream),
`VFW_E_UNSUPPORTED_STREAM` (MPEG audio layer III alone), `VFW_S_AUDIO_NOT_RENDERED` (video with layer III sound: the video
plays silent).

## Formats (src/media)

What Windows decodes with its own splitter and decoders (no codec installed): **MPEG-1 system streams** (and the MPEG-2
program stream pack header), **MPEG-1 video** and **MPEG audio layers I / II** elementary streams. Chrome decodes none
of these (neither media elements nor WebCodecs), so they are decoded here, written from the ISO/IEC 11172 standards:

- `mpeg-ps.js`: demultiplexer (packs, PES packets with MPEG-1 or MPEG-2 headers, time stamps), incremental.
- `mpeg1-video.js`: I / P / B / D pictures, half-pel motion compensation with edge extension, quantizer matrices, the
  inverse DCT in double precision (even / odd butterflies; equal to the definition up to the rounding of exact halves).
- `mpeg-audio.js`: layers I and II (all bit allocation tables, MPEG-2 low sampling frequencies, intensity stereo),
  polyphase synthesis. The synthesis window (`mpeg-audio-window.js`, a constant of the standard, table B.3) was
  recovered by `tools/mpa-window-fit.mjs`: the decoder's output is linear in the 512 window values, so a least-squares
  fit against a reference decoding gives them; every value lands within 0.07 units of a multiple of 2^-16 (the table's
  unit) and the halves mirror each other as the standard says.
- `mpeg-source.js`: a file being played: read ahead in 256 KiB chunks (asynchronously when the range is still on the
  network: `file.prepare`), pictures and sound decoded on demand for a stream time; a caller late by more than one
  picture has the B pictures in between dropped undecoded.
- `yuv.js`: BT.601 studio-range Y'CbCr 4:2:0 → RGBA.

Accuracy (tests/media-mpeg.test.js, against ffmpeg's decoders): video 45-66 dB PSNR per picture (only the inverse
DCT's rounding differs from ffmpeg's integer transform), audio > 110 dB SNR (float rounding).

## Output

- **Pictures**: the host display's video layer (`BrowserDisplay.presentVideo`: a display-sized transparent layer above
  the GDI and Direct3D layers, `#vid` on the page), the picture stretched to the video window's rectangle — the owner's
  client area plus the window's position for a child window, the destination rectangle inside it — as the video
  renderer's window covers the game's. The layer is hidden when the window is hidden or the graph released. Input goes to
  the game's window (the video window is not a real window: the message drain games set is where it would go anyway).
- **Sound**: a stream voice of the DirectSound mixer (`dsound.js createAudioStream`): a looping 16-bit ring in guest
  memory mixed by the AudioWorklet like any DirectSound buffer; the graph writes the decoded samples 250 ms ahead of the
  play cursor, both following the VM clock, so pictures and sound stay together.
- **Clock**: the VM clock. `vm.media` (MediaClock) is advanced by the scheduler at its wake-up passes
  (`Sched.wakeBlocked`) and asks it to wake up for the next picture or sound refill (`Sched.nextWake`): playback goes on
  while the game's threads wait (`WaitForCompletion`, a message wait, `Sleep`).

Logs: `--log video` (RenderFile, Run, completion and release with statistics: pictures shown, decoded then overtaken,
B pictures skipped, decoding and showing time per picture, lateness).

## Measured

Vice City (640x480, 25 fps, 48 kHz stereo; headless Chromium with SwiftShader on the shared server): see the commit
message of the feature for the figures of the run.
