// Page side: manifest picker, canvases handed to the worker, input capture into the shared ring,
// audio worklet fed from the shared float ring, perf HUD, and a small window.orthros API for the
// headless harness (status, stats, screenshots, logs).
import { CTL, IN_RING, EV, AUDIO_RING_FRAMES, AUDIO_RATE } from '../browser-host.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const headless = params.get('headless') === '1';
const state = { status: 'menu', stats: null, logs: [], exitCode: null, crash: null, worker: null, ctl: null, inputRing: null, head: 0, mode: { width: 1024, height: 768 }, pointerLocked: false, lastX: 0, lastY: 0 };
window.orthros = state;

async function main() {
  const list = await (await fetch('/api/manifests')).json();
  const games = $('games');
  for (const g of list) { const b = document.createElement('button'); b.textContent = `${g.title} (${g.exe})`; b.onclick = () => start(g.name); games.appendChild(b); }
  $('hudToggle').onchange = () => { $('hud').style.display = $('hudToggle').checked && state.status !== 'menu' ? 'block' : 'none'; };
  $('logToggle').onchange = () => { $('log').style.display = $('logToggle').checked ? 'block' : 'none'; };
  const auto = params.get('manifest');
  if (auto) start(auto);
}

async function start(name) {
  const manifest = await (await fetch(`/api/manifest/${name}`)).json();
  const tree = await (await fetch(`/api/tree/${name}`)).json();
  state.status = 'starting'; state.manifest = name;
  $('menu').classList.add('hidden'); $('stage').classList.remove('hidden');
  if ($('hudToggle').checked) $('hud').style.display = 'block';
  // the worker renders into its own OffscreenCanvases and posts complete frames as ImageBitmaps
  state.ctx2d = $('c2d').getContext('bitmaprenderer'); state.ctxGl = $('gl').getContext('bitmaprenderer');
  resizeTo(manifest.display.width, manifest.display.height);
  const ctlSab = new SharedArrayBuffer(CTL.SIZE * 4), inputSab = new SharedArrayBuffer(IN_RING * 4), audioSab = new SharedArrayBuffer(AUDIO_RING_FRAMES * 2 * 4);
  state.ctl = new Int32Array(ctlSab); state.inputRing = new Int32Array(inputSab);
  const worker = new Worker('/src/host/web/worker.js', { type: 'module' });
  state.worker = worker;
  worker.onmessage = (e) => onWorkerMessage(e.data);
  worker.onerror = (e) => log('crash', `worker error: ${e.message}`);
  const opts = { headless, interp: params.get('interp') === '1', log: params.get('log') ? params.get('log').split(',') : undefined, cacheBlocks: Number(params.get('cache') || 256), dumpShaders: params.get('dump') === '1', captureFrame: Number(params.get('capture') || 0), captureDraws: params.get('capturedraws') === '1', burstFromId: Number(params.get('burstfrom') || 0), noCull: params.get('nocull') === '1', jitProfile: params.get('jitprof') === '1', glDiscard: params.get('gldiscard') === '1', watchTex: params.get('watchtex') || '', noF32: params.get('nof32') === '1', f32Off: params.get('f32off') || '', profileFiles: window.__orthrosProfile, opfs: params.get('opfs') === '1', slowFrom: Number(params.get('slowfrom') || 0) };
  worker.postMessage({ type: 'start', name, manifest, tree, ctl: ctlSab, inputRing: inputSab, audioRing: audioSab, opts });
  setupInput();
  if (!headless || params.get('audio') === '1') setupAudio(audioSab, ctlSab).catch((e) => log('warn', `audio unavailable: ${e.message}`));
  if (performance.measureUserAgentSpecificMemory) { const tick = async () => { try { const m = await performance.measureUserAgentSpecificMemory(); state.memoryMB = Math.round(m.bytes / 1048576); } catch { /* not available */ } setTimeout(tick, 5000); }; tick(); }
}

function resizeTo(w, h) {
  state.mode = { width: w, height: h };
  const frame = $('frame');
  frame.style.width = w + 'px'; frame.style.height = h + 'px';
  for (const id of ['c2d', 'gl']) { const c = $(id); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } }
  fit();
}
function fit() {
  const { width: w, height: h } = state.mode;
  const s = Math.min(innerWidth / w, innerHeight / h, headless ? 1 : Infinity);
  const frame = $('frame');
  frame.style.transform = `scale(${s})`; frame.style.transformOrigin = 'center';
  // nearest-neighbour only for whole scale factors (crisp, even pixels); a fractional scale is filtered smoothly
  for (const c of frame.querySelectorAll('canvas')) c.style.imageRendering = Number.isInteger(s) ? 'pixelated' : 'auto';
  state.scale = s;
}
addEventListener('resize', fit);

function onWorkerMessage(m) {
  switch (m.type) {
    case 'log': log(m.kind, m.msg); break;
    case 'stdout': log('stdout', m.text); break;
    case 'started': state.status = 'running'; break;
    case 'stats': state.stats = m; state.statsAt = Date.now(); if (state.audio) { m.audioState = state.audio.state; m.audioUnderruns = Atomics.load(state.ctl, CTL.AUDIO_UNDERRUNS); } renderHud(); break;
    case 'frame': { const c = $(m.layer === 'gl' ? 'gl' : 'c2d'); if (c.width !== m.bitmap.width || c.height !== m.bitmap.height) { c.width = m.bitmap.width; c.height = m.bitmap.height; } (m.layer === 'gl' ? state.ctxGl : state.ctx2d).transferFromImageBitmap(m.bitmap); break; }
    case 'mode': resizeTo(m.width, m.height); break;
    case 'title': document.title = m.title || 'Orthros'; break;
    case 'cursor': state.cursorVisible = m.visible; applyCursor(); break;
    case 'cursor-def': { const frames = m.frames.map((f) => { const u8 = new Uint8Array(f.png); let bin = ''; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return `url(data:image/png;base64,${btoa(bin)}) ${f.hotX} ${f.hotY}, auto`; }); (state.cursors ??= new Map()).set(m.id, { frames, steps: m.steps }); break; }
    case 'cursor-set': state.cursor = m.id !== undefined ? { id: m.id } : { system: m.system }; applyCursor(); break;
    case 'gl': $('gl').style.zIndex = m.active ? '2' : '0'; $('c2d').style.zIndex = m.active ? '1' : '2'; $('gl').style.visibility = m.active ? 'visible' : 'hidden'; break;
    case 'exit': state.status = 'exited'; state.exitCode = m.code; log('crash', `process exited with code ${m.code}${m.reason ? ` (${m.reason})` : ''}`); break;
    case 'crash': state.status = 'crashed'; state.crash = m.report; log('crash', m.report); break;
    case 'report': state.report = m.text; log('report', m.text); break;
    case 'regions': state.regions = m.text; break;
    case 'corpus': state.corpus = m.text; break;
    case 'profile': state.profile = m.files; break;
    case 'frames': state.frames = m.text; log('frames', m.text); break;
    case 'dump': { const u8 = new Uint8Array(m.data); let bin = ''; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); (state.dumps ??= []).push({ name: m.name, data: btoa(bin) }); break; } // frame-capture PNGs, collected by the headless harness
  }
}

/** Windows system cursor ids (IDC_*) as CSS cursors */
const SYSTEM_CURSORS = { 32512: 'default', 32513: 'text', 32514: 'wait', 32515: 'crosshair', 32516: 'default', 32642: 'nwse-resize', 32643: 'nesw-resize', 32644: 'ew-resize', 32645: 'ns-resize', 32646: 'move', 32648: 'not-allowed', 32649: 'pointer', 32650: 'progress', 32651: 'help' };
/** Show the guest cursor on the frame (inherited by both canvases): hidden, a system cursor, or an animated image cursor. */
function applyCursor() {
  clearTimeout(state.cursorTimer);
  const frame = $('frame');
  $('c2d').style.cursor = '';
  if (state.cursorVisible === false) { frame.style.cursor = 'none'; return; }
  const cur = state.cursor, def = cur?.id !== undefined ? state.cursors?.get(cur.id) : null;
  if (!def) { frame.style.cursor = SYSTEM_CURSORS[cur?.system] ?? 'default'; return; }
  let step = 0;
  const show = () => {
    const s = def.steps[step % def.steps.length];
    frame.style.cursor = state.pointerLocked ? 'none' : def.frames[s.frame];
    state.softStep = step; drawSoftCursor();
    if (def.steps.length > 1) { step++; state.cursorTimer = setTimeout(show, Math.max(16, s.ms)); }
  };
  show();
}

function log(kind, msg) {
  const line = `[${kind}] ${msg}`;
  state.logs.push(line); if (state.logs.length > 5000) state.logs.shift();
  if (headless) console.log(line);
  const el = $('log');
  if (el.style.display !== 'none') { el.textContent += line + '\n'; el.scrollTop = el.scrollHeight; }
}

function renderHud() {
  const s = state.stats; if (!s) return;
  $('hud').textContent = `${state.status}  ${s.fps.toFixed(1)} fps  frame p50 ${s.frameP50.toFixed(1)} ms  p99 ${s.frameP99.toFixed(1)} ms\n${s.mips.toFixed(0)} M instr/s  ${s.apiPerSec.toFixed(0)} api/s  regions ${s.regions}  threads ${s.threads}\n${s.d3d ? `d3d ${s.d3d.w}x${s.d3d.h} frames ${s.d3d.frames} draws ${s.d3d.draws}` : s.firstD3D ? `dx: ${s.firstD3D}` : 'no dx yet'}  unknown imports ${s.unknownImports}`;
}

// ---------------------------------------------------------------- input
function push(type, a, b, c) {
  const ctl = state.ctl, ring = state.inputRing; if (!ctl) return;
  const head = Atomics.load(ctl, CTL.IN_HEAD);
  const tail = Atomics.load(ctl, CTL.IN_TAIL);
  if (((head - tail) | 0) >= IN_RING / 4 - 1) return; // ring full: drop
  const i = (head % (IN_RING / 4)) * 4;
  ring[i] = type; ring[i + 1] = a | 0; ring[i + 2] = b | 0; ring[i + 3] = c | 0;
  Atomics.store(ctl, CTL.IN_HEAD, (head + 1) | 0);
  Atomics.notify(ctl, CTL.WAKE);
  state.worker?.postMessage({ type: 'wake' });
}
/** Type a string as key down / char / key up events (letters, digits, space), for scripted runs. */
function typeText(text) {
  for (const ch of text) {
    const code = /[a-z]/i.test(ch) ? 'Key' + ch.toUpperCase() : /[0-9]/.test(ch) ? 'Digit' + ch : ch === ' ' ? 'Space' : null;
    if (!code) continue;
    const vk = vkOf({ code }), scan = SCAN[code] ?? 0;
    push(EV.KEYDOWN, vk, scan, 0); push(EV.CHAR, ch.charCodeAt(0), 0, 0); push(EV.KEYUP, vk, scan, 0);
  }
}
window.orthrosInput = { push, EV, typeText };

function canvasPos(e) {
  if (state.pointerLocked) { // captured mouse: a virtual cursor inside the game screen, moved by the relative motion
    const s = state.scale || 1, { width: w, height: h } = state.mode;
    state.vx = Math.max(0, Math.min(w - 1, (state.vx ?? w / 2) + e.movementX / s));
    state.vy = Math.max(0, Math.min(h - 1, (state.vy ?? h / 2) + e.movementY / s));
    drawSoftCursor();
    return [Math.round(state.vx), Math.round(state.vy)];
  }
  const r = $('c2d').getBoundingClientRect();
  const s = state.scale || 1;
  return [Math.round((e.clientX - r.left) / s), Math.round((e.clientY - r.top) / s)];
}
/**
 * Play mode: fullscreen + pointer lock (the mouse cannot leave the game, screen-edge scrolling works) + keyboard lock
 * (Escape reaches the game; holding it leaves fullscreen). The guest cursor is then drawn by the page (#softcursor).
 */
async function enterPlayMode() {
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { /* not allowed */ }
  try { await navigator.keyboard?.lock?.(['Escape']); } catch { /* keyboard lock unavailable */ }
  try { await $('c2d').requestPointerLock({ unadjustedMovement: true }); } catch { try { await $('c2d').requestPointerLock(); } catch { /* denied */ } }
}
function drawSoftCursor() {
  const el = $('softcursor');
  if (!state.pointerLocked || state.cursorVisible === false) { el.style.display = 'none'; return; }
  const cur = state.cursor, def = cur?.id !== undefined ? state.cursors?.get(cur.id) : null;
  const frame = def ? def.frames[def.steps[(state.softStep ?? 0) % def.steps.length].frame] : null;
  const url = frame ? frame.match(/url\((.*?)\) (\d+) (\d+)/) : null;
  if (url) { if (el.src !== url[1]) el.src = url[1]; el.style.marginLeft = -url[2] + 'px'; el.style.marginTop = -url[3] + 'px'; }
  else { if (!el.dataset.arrow) { el.dataset.arrow = '1'; el.src = ARROW; } el.style.marginLeft = el.style.marginTop = '0px'; }
  el.style.display = 'block';
  el.style.left = state.vx + 'px'; el.style.top = state.vy + 'px';
}
/** A plain arrow (SVG) for the software cursor when the guest shows a system cursor. */
const ARROW = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="19"><path d="M0.5 0.5v16l4-4 3 6 2.5-1-3-6h5.5z" fill="white" stroke="black"/></svg>');
const SCAN = { Escape: 0x01, Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06, Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b, Minus: 0x0c, Equal: 0x0d, Backspace: 0x0e, Tab: 0x0f, KeyQ: 0x10, KeyW: 0x11, KeyE: 0x12, KeyR: 0x13, KeyT: 0x14, KeyY: 0x15, KeyU: 0x16, KeyI: 0x17, KeyO: 0x18, KeyP: 0x19, BracketLeft: 0x1a, BracketRight: 0x1b, Enter: 0x1c, ControlLeft: 0x1d, KeyA: 0x1e, KeyS: 0x1f, KeyD: 0x20, KeyF: 0x21, KeyG: 0x22, KeyH: 0x23, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29, ShiftLeft: 0x2a, Backslash: 0x2b, KeyZ: 0x2c, KeyX: 0x2d, KeyC: 0x2e, KeyV: 0x2f, KeyB: 0x30, KeyN: 0x31, KeyM: 0x32, Comma: 0x33, Period: 0x34, Slash: 0x35, ShiftRight: 0x36, NumpadMultiply: 0x37, AltLeft: 0x38, Space: 0x39, CapsLock: 0x3a, F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41, F8: 0x42, F9: 0x43, F10: 0x44, NumLock: 0x45, ScrollLock: 0x46, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, NumpadSubtract: 0x4a, Numpad4: 0x4b, Numpad5: 0x4c, Numpad6: 0x4d, NumpadAdd: 0x4e, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53, F11: 0x57, F12: 0x58, NumpadEnter: 0x11c, ControlRight: 0x11d, NumpadDivide: 0x135, PrintScreen: 0x137, AltRight: 0x138, Pause: 0x45, Home: 0x147, ArrowUp: 0x148, PageUp: 0x149, ArrowLeft: 0x14b, ArrowRight: 0x14d, End: 0x14f, ArrowDown: 0x150, PageDown: 0x151, Insert: 0x152, Delete: 0x153, MetaLeft: 0x15b, MetaRight: 0x15c, ContextMenu: 0x15d };
const VK = { Escape: 0x1b, Backspace: 8, Tab: 9, Enter: 13, NumpadEnter: 13, ShiftLeft: 0xa0, ShiftRight: 0xa1, ControlLeft: 0xa2, ControlRight: 0xa3, AltLeft: 0xa4, AltRight: 0xa5, Pause: 0x13, CapsLock: 0x14, Space: 0x20, PageUp: 0x21, PageDown: 0x22, End: 0x23, Home: 0x24, ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28, PrintScreen: 0x2c, Insert: 0x2d, Delete: 0x2e, MetaLeft: 0x5b, MetaRight: 0x5c, ContextMenu: 0x5d, NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f, NumLock: 0x90, ScrollLock: 0x91, Semicolon: 0xba, Equal: 0xbb, Comma: 0xbc, Minus: 0xbd, Period: 0xbe, Slash: 0xbf, Backquote: 0xc0, BracketLeft: 0xdb, Backslash: 0xdc, BracketRight: 0xdd, Quote: 0xde };
function vkOf(e) {
  const c = e.code;
  if (VK[c] !== undefined) return VK[c];
  if (/^Key[A-Z]$/.test(c)) return c.charCodeAt(3);
  if (/^Digit[0-9]$/.test(c)) return c.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(c)) return 0x60 + Number(c[6]);
  if (/^F([0-9]+)$/.test(c)) return 0x70 + Number(c.slice(1)) - 1;
  return 0;
}

function setupInput() {
  const c = $('c2d');
  c.addEventListener('mousemove', (e) => { const [x, y] = canvasPos(e); const dx = state.pointerLocked ? e.movementX : x - state.lastX, dy = state.pointerLocked ? e.movementY : y - state.lastY; state.lastX = x; state.lastY = y; push(EV.MOUSEMOVE, x, y, ((dy & 0xffff) << 16) | (dx & 0xffff)); });
  c.addEventListener('mousedown', (e) => { const [x, y] = canvasPos(e); push(EV.MOUSEDOWN, e.button === 2 ? 1 : e.button === 1 ? 2 : e.button, x, y); e.preventDefault(); });
  c.addEventListener('mouseup', (e) => { const [x, y] = canvasPos(e); push(EV.MOUSEUP, e.button === 2 ? 1 : e.button === 1 ? 2 : e.button, x, y); e.preventDefault(); });
  c.addEventListener('contextmenu', (e) => e.preventDefault());
  c.addEventListener('wheel', (e) => { const [x, y] = canvasPos(e); push(EV.WHEEL, e.deltaY < 0 ? 120 : -120, x, y); e.preventDefault(); }, { passive: false });
  addEventListener('keydown', (e) => { if (e.code === 'F12' && !e.shiftKey) return; const s = SCAN[e.code] ?? 0; push(EV.KEYDOWN, vkOf(e), s, e.repeat ? 1 : 0); if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) push(EV.CHAR, e.key.charCodeAt(0), 0, 0); if (!(e.ctrlKey && (e.code === 'KeyR' || e.code === 'KeyL'))) e.preventDefault(); });
  addEventListener('keyup', (e) => { push(EV.KEYUP, vkOf(e), SCAN[e.code] ?? 0, 0); e.preventDefault(); });
  addEventListener('blur', () => push(EV.FOCUS, 0, 0, 0));
  addEventListener('focus', () => push(EV.FOCUS, 1, 0, 0));
  document.addEventListener('pointerlockchange', () => { state.pointerLocked = document.pointerLockElement === c; if (state.pointerLocked) { state.vx = state.lastX; state.vy = state.lastY; } drawSoftCursor(); });
  if (!headless) addEventListener('keydown', (e) => { if (e.code === 'F11' || (e.code === 'Enter' && e.altKey)) { e.preventDefault(); if (document.fullscreenElement) { document.exitPointerLock(); document.exitFullscreen(); } else enterPlayMode(); } }, true);
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) navigator.keyboard?.unlock?.(); });
}

async function setupAudio(audioSab, ctlSab) {
  const ctx = new AudioContext({ sampleRate: AUDIO_RATE, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('/src/host/web/audio-worklet.js');
  const node = new AudioWorkletNode(ctx, 'orthros-output', { outputChannelCount: [2], processorOptions: { audio: audioSab, ctl: ctlSab, frames: AUDIO_RING_FRAMES, write: CTL.AUDIO_WRITE, read: CTL.AUDIO_READ, underruns: CTL.AUDIO_UNDERRUNS } });
  node.connect(ctx.destination);
  const resume = () => { if (ctx.state !== 'running') ctx.resume(); };
  addEventListener('mousedown', resume); addEventListener('keydown', resume);
  state.audio = ctx;
}

main();
