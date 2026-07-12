/**
 * Standalone video decoder test page.
 * No emulator dependency — loads video-decoder.wasm directly.
 *
 * Usage: open tools/video-test/index.html via the Vite dev server, or
 * serve the project root with any static server.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

interface WasmExports extends WebAssembly.Exports {
    memory:                      WebAssembly.Memory;
    decoder_alloc:               (size: number) => number;
    decoder_free:                (ptr: number)  => void;
    decoder_open:                (data: number, size: number) => number;
    decoder_do_frame:            (handle: number) => number;
    decoder_get_frame_rgba_ptr:  (handle: number) => number;
    decoder_get_audio_frame:     (handle: number, out: number, outSize: number) => number;
    decoder_get_audio_available: (handle: number) => number;
    decoder_next_frame:          (handle: number) => void;
    decoder_goto_frame:          (handle: number, frame: number) => void;
    decoder_get_width:           (handle: number) => number;
    decoder_get_height:          (handle: number) => number;
    decoder_get_frame_count:     (handle: number) => number;
    decoder_get_current_frame:   (handle: number) => number;
    decoder_get_fps:             (handle: number) => number;
    decoder_get_audio_sample_rate:(handle: number) => number;
    decoder_get_audio_channels:  (handle: number) => number;
    decoder_close:               (handle: number) => void;
}

// ── WASI stubs ────────────────────────────────────────────────────────────────

const WASI_IMPORTS = {
    wasi_snapshot_preview1: {
        proc_exit:          (code: number) => { throw new Error(`WASM exit ${code}`); },
        fd_write:           () => 0,
        fd_read:            () => 0,
        fd_seek:            () => 0,
        fd_close:           () => 0,
        fd_fdstat_get:      () => 0,
        environ_sizes_get:  () => 0,
        environ_get:        () => 0,
        args_sizes_get:     () => 0,
        args_get:           () => 0,
        clock_time_get:     () => 0,
        clock_res_get:      () => 0,
        sched_yield:        () => 0,
        random_get:         () => 0,
    },
};

// ── DOM refs ──────────────────────────────────────────────────────────────────

const canvas    = document.getElementById("canvas")    as HTMLCanvasElement;
const ctx2d     = canvas.getContext("2d")!;
const dropZone  = document.getElementById("drop-zone") as HTMLDivElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const logEl     = document.getElementById("log")       as HTMLDivElement;
const progress  = document.getElementById("progress")  as HTMLProgressElement;

const statFile  = document.getElementById("stat-file")  as HTMLSpanElement;
const statRes   = document.getElementById("stat-res")   as HTMLSpanElement;
const statFrame = document.getElementById("stat-frame") as HTMLSpanElement;
const statFps   = document.getElementById("stat-fps")   as HTMLSpanElement;
const statRFps  = document.getElementById("stat-rfps")  as HTMLSpanElement;
const statAudio = document.getElementById("stat-audio") as HTMLSpanElement;

const btnPlay   = document.getElementById("btn-play")   as HTMLButtonElement;
const btnPause  = document.getElementById("btn-pause")  as HTMLButtonElement;
const btnStop   = document.getElementById("btn-stop")   as HTMLButtonElement;
const btnMute   = document.getElementById("btn-mute")   as HTMLButtonElement;

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg: string, level: "info" | "warn" | "err" = "info"): void {
    console[level === "err" ? "error" : level === "warn" ? "warn" : "log"](msg);
    const el = document.createElement("div");
    if (level !== "info") el.className = level;
    el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.prepend(el);
    while (logEl.children.length > 80) logEl.removeChild(logEl.lastChild!);
}

// ── WASM loader ───────────────────────────────────────────────────────────────

let wasm: WasmExports | null = null;

async function loadWasm(): Promise<WasmExports> {
    if (wasm) return wasm;
    log("Loading /video-decoder.wasm …");
    const resp = await fetch("/video-decoder.wasm");
    if (!resp.ok) throw new Error(`fetch /video-decoder.wasm → ${resp.status}`);
    const bytes  = await resp.arrayBuffer();
    const result = await WebAssembly.instantiate(bytes, WASI_IMPORTS as WebAssembly.Imports);
    wasm = result.instance.exports as unknown as WasmExports;
    log("WASM loaded");
    return wasm;
}

function getMemView(w: WasmExports): Uint8Array {
    return new Uint8Array(w.memory.buffer);
}

// ── Playback state ────────────────────────────────────────────────────────────

let wasmHandle   = -1;
let vidWidth     = 0;
let vidHeight    = 0;
let vidFps       = 15;
let frameCount   = 0;
let playing      = false;
let paused       = false;
let muted        = false;
let rafId: number | null = null;
let lastFrameTime = 0;
let lastRafTime   = 0;
let renderFpsAccum = 0;
let renderFpsCount = 0;
let renderFpsLast  = 0;

// Audio
let audioCtx: AudioContext | null = null;
let audioSampleRate = 0;
let audioChannels   = 0;

const AUDIO_LATENCY_BUF = 0.2; // seconds of audio ahead to keep buffered

function getAudioTime(): number {
    return audioCtx ? audioCtx.currentTime : 0;
}

let audioScheduledUntil = 0;

function scheduleAudio(pcmBytes: Uint8Array): void {
    if (!audioCtx || muted || audioChannels === 0 || audioSampleRate === 0) return;
    if (pcmBytes.byteLength === 0) return;

    const samples    = pcmBytes.byteLength >> 1;           // S16 samples
    const frames     = samples / audioChannels;
    const duration   = frames / audioSampleRate;

    const buffer     = audioCtx.createBuffer(audioChannels, frames, audioSampleRate);
    const i16        = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, samples);

    for (let ch = 0; ch < audioChannels; ch++) {
        const data = buffer.getChannelData(ch);
        for (let i = 0; i < frames; i++) {
            data[i] = i16[i * audioChannels + ch] / 32768;
        }
    }

    const now   = audioCtx.currentTime;
    const start = Math.max(now + 0.01, audioScheduledUntil);
    const src   = audioCtx.createBufferSource();
    src.buffer  = buffer;
    src.connect(audioCtx.destination);
    src.start(start);
    audioScheduledUntil = start + duration;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

let imageData: ImageData | null = null;

function renderFrame(w: WasmExports): void {
    const ptr = w.decoder_get_frame_rgba_ptr(wasmHandle);
    if (!ptr) return;

    const mem = getMemView(w);
    const rgba = mem.subarray(ptr, ptr + vidWidth * vidHeight * 4);

    if (!imageData || imageData.width !== vidWidth || imageData.height !== vidHeight) {
        imageData = new ImageData(vidWidth, vidHeight);
        canvas.width  = vidWidth;
        canvas.height = vidHeight;
    }
    imageData.data.set(rgba);
    ctx2d.putImageData(imageData, 0, 0);
}

function drainAudioFrame(w: WasmExports): void {
    const avail = w.decoder_get_audio_available(wasmHandle);
    if (avail <= 0) return;

    const outPtr = w.decoder_alloc(avail);
    if (!outPtr) return;
    w.decoder_get_audio_frame(wasmHandle, outPtr, avail);
    const mem = getMemView(w);
    const bytes = mem.slice(outPtr, outPtr + avail);
    w.decoder_free(outPtr);
    scheduleAudio(bytes);
}

function playbackLoop(w: WasmExports, now: number): void {
    if (!playing || paused) return;

    const elapsed = now - lastRafTime;
    lastRafTime = now;

    /* Track render FPS */
    renderFpsAccum += elapsed;
    renderFpsCount++;
    if (renderFpsAccum >= 1000) {
        const fps = (renderFpsCount / renderFpsAccum) * 1000;
        statRFps.textContent = fps.toFixed(1);
        renderFpsAccum = 0;
        renderFpsCount = 0;
    }

    /* Advance frame(s) based on elapsed time */
    const msPerFrame = 1000 / vidFps;
    lastFrameTime += elapsed;

    while (lastFrameTime >= msPerFrame) {
        lastFrameTime -= msPerFrame;

        const ret = w.decoder_do_frame(wasmHandle);
        if (ret < 0) {
            log("Video ended");
            stop();
            return;
        }
        drainAudioFrame(w);
        w.decoder_next_frame(wasmHandle);

        const cur    = w.decoder_get_current_frame(wasmHandle);
        statFrame.textContent = `${cur} / ${frameCount}`;
        progress.value = frameCount > 0 ? cur / frameCount : 0;
    }

    renderFrame(w);
    rafId = requestAnimationFrame(t => playbackLoop(w, t));
}

function stop(): void {
    playing = false;
    paused  = false;
    if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
    if (wasm && wasmHandle >= 0) {
        wasm.decoder_close(wasmHandle);
        wasmHandle = -1;
    }
    audioScheduledUntil = 0;
    btnPlay.disabled  = true;
    btnPause.disabled = true;
    btnStop.disabled  = true;
    btnMute.disabled  = true;
    progress.value = 0;
    log("Stopped");
}

// ── File loading ──────────────────────────────────────────────────────────────

async function loadFile(file: File): Promise<void> {
    stop();

    log(`Loading "${file.name}" (${(file.size / 1048576).toFixed(1)} MB) …`);
    statFile.textContent = file.name;
    statRes.textContent  = "…";
    statFrame.textContent = "…";
    statFps.textContent  = "…";
    statAudio.textContent = "…";
    statRFps.textContent = "—";

    let w: WasmExports;
    try {
        w = await loadWasm();
    } catch (e) {
        log(`Failed to load WASM: ${e}`, "err");
        return;
    }

    const bytes    = new Uint8Array(await file.arrayBuffer());
    const wptr     = w.decoder_alloc(bytes.byteLength);
    if (!wptr) { log("decoder_alloc failed", "err"); return; }
    new Uint8Array(w.memory.buffer).set(bytes, wptr);

    const handle = w.decoder_open(wptr, bytes.byteLength);
    if (handle < 0) {
        log(`decoder_open failed — unsupported format?`, "err");
        w.decoder_free(wptr);
        return;
    }

    wasmHandle  = handle;
    vidWidth    = w.decoder_get_width(handle);
    vidHeight   = w.decoder_get_height(handle);
    frameCount  = w.decoder_get_frame_count(handle);
    vidFps      = w.decoder_get_fps(handle) || 15;
    audioSampleRate = w.decoder_get_audio_sample_rate(handle);
    audioChannels   = w.decoder_get_audio_channels(handle);

    statRes.textContent   = `${vidWidth} × ${vidHeight}`;
    statFrame.textContent = `0 / ${frameCount}`;
    statFps.textContent   = vidFps.toFixed(2);
    statAudio.textContent = audioSampleRate > 0
        ? `${audioSampleRate} Hz × ${audioChannels}ch`
        : "none";

    log(`Opened: ${vidWidth}×${vidHeight} @ ${vidFps.toFixed(2)}fps, ${frameCount} frames`);
    if (audioSampleRate > 0) log(`Audio: ${audioSampleRate} Hz, ${audioChannels} channels`);

    /* Init WebAudio */
    if (audioSampleRate > 0) {
        audioCtx?.close();
        audioCtx = new AudioContext({ sampleRate: audioSampleRate });
        audioScheduledUntil = 0;
    }

    /* Decode first frame so canvas shows something */
    w.decoder_do_frame(handle);
    renderFrame(w);

    playing = true;
    paused  = false;
    lastFrameTime = 0;
    lastRafTime   = performance.now();

    btnPlay.disabled  = true;
    btnPause.disabled = false;
    btnStop.disabled  = false;
    btnMute.disabled  = audioSampleRate <= 0;

    rafId = requestAnimationFrame(t => playbackLoop(w, t));
}

// ── Event wiring ──────────────────────────────────────────────────────────────

fileInput.addEventListener("change", () => {
    if (fileInput.files?.[0]) loadFile(fileInput.files[0]);
});

dropZone.addEventListener("dragover",  e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
dropZone.addEventListener("drop", e => {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFile(f);
});

btnPlay.addEventListener("click", () => {
    if (wasm && wasmHandle >= 0 && paused) {
        paused = false;
        lastRafTime = performance.now();
        rafId = requestAnimationFrame(t => playbackLoop(wasm!, t));
        btnPlay.disabled  = true;
        btnPause.disabled = false;
    }
});

btnPause.addEventListener("click", () => {
    if (playing && !paused) {
        paused = true;
        if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; }
        btnPlay.disabled  = false;
        btnPause.disabled = true;
    }
});

btnStop.addEventListener("click", () => stop());

btnMute.addEventListener("click", () => {
    muted = !muted;
    btnMute.textContent = muted ? "🔊 Unmute" : "🔇 Mute";
});
