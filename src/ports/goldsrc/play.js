// The page of a GoldSrc browser port (src/host/goldsrc.js, docs/browser-ports.md), /ports/goldsrc/<manifest>/: the
// pinned engine release the manifest names (/engines/<release>/), the version's game files streamed (files.js: what
// the game reads first loaded before it starts, the rest as it goes; kept in IndexedDB), the writable profile (saves,
// settings) in IndexedDB under the installation's key, multiplayer through the server's relay (/api/udp/<manifest>).
// Around the game, the page of the Windows games' look (/src/host/web/player.css): the header (frame rate, full screen,
// back to the games), the loading screen — the player's choices first, then the start's progress — and the game filling
// the rest of the window. It never loads the Win32 runtime, and nothing here names a game.
import { pickLang } from '../../host/web/lang.js';
import { openStorage, readStorage, writeStorage, storageKeys, removeStorage, writableSnapshot, restoreSnapshot } from './storage.js';
import { StreamedFiles, treeFiles, learnedPlan, PIECE } from './files.js';

const STRINGS = {
  en: {
    games: '☰ Games', gamesTitle: 'quit the game (saves and settings kept) and return to the game list', fullscreen: '⛶ Full screen',
    fullscreenTitle: 'full screen: only the game (hold Esc to leave)', perfTitle: 'frames per second, the last minute, the slowest frames',
    name: 'Nickname', play: 'Play', log: 'Launch log', subtitle: 'its original files, on a game engine in your browser',
    loading: 'Loading the game…', preparing: 'Preparing the installation.',
    ready: 'Start the game: single player and multiplayer are in its menu.',
    readyServer: 'Start the game: single player and multiplayer are in its menu — Orthros\' server is in its LAN games.',
    failed: 'The game could not start: ', isolated: 'This page must be served with the browser isolation headers',
    init: 'Starting the engine…', files: (pct) => `Loading the files · ${pct} %`,
    starting: 'Starting the game…', running: 'Game started. Click in the game to play.',
    steps: { engine: 'Starting the engine', files: 'Downloading the game files', game: 'Starting the game' },
    capture: 'Click the game to capture the mouse · Esc releases it · ⛶ for full screen',
    released: 'Mouse released · click the game to capture it again', quit: (title) => `Quit ${title}? Saves and settings are kept.`,
    tips: [
      'The first launch downloads the game files into this browser: the next ones start from its own copy, much faster.',
      'Full screen (button above) gives the game the whole screen; hold Esc to leave it.',
      'In the game, a click captures the mouse; Esc releases it, and in the menus the mouse is free.',
      'The game runs entirely in your browser, from its original files: nothing is installed.',
    ],
    saveFailed: 'Saving in the browser failed. Keep this page open to retry.', stopped: 'Game over. Saves and settings are kept.',
    cannotSave: 'Cannot save: ', lost: 'Connection to the multiplayer server lost: join it again from the game\'s multiplayer menu (LAN games).',
    engineFiles: 'Engine resources unavailable', restart: 'Restart the game', paused: 'paused', loadingShort: 'loading',
  },
  fr: {
    games: '☰ Jeux', gamesTitle: 'quitter la partie (sauvegardes et réglages conservés) et revenir à la liste des jeux', fullscreen: '⛶ Plein écran',
    fullscreenTitle: 'plein écran : le jeu seul (maintiens Échap pour sortir)', perfTitle: 'images par seconde, la dernière minute, les images les plus lentes',
    name: 'Pseudo', play: 'Jouer', log: 'Journal de lancement', subtitle: 'ses fichiers d’origine, sur un moteur de jeu dans ton navigateur',
    loading: 'Chargement du jeu…', preparing: 'Préparation de l’installation.',
    ready: 'Lance le jeu : le solo et le multijoueur sont dans son menu.',
    readyServer: 'Lance le jeu : le solo et le multijoueur sont dans son menu — le serveur d’Orthros est dans ses parties en réseau local (LAN).',
    failed: 'Le jeu n’a pas pu démarrer : ', isolated: 'Cette page doit être servie avec les en-têtes d’isolation du navigateur',
    init: 'Démarrage du moteur…', files: (pct) => `Chargement des fichiers · ${pct} %`,
    starting: 'Lancement du jeu…', running: 'Partie lancée. Clique dans le jeu pour jouer.',
    steps: { engine: 'Démarrage du moteur', files: 'Téléchargement des fichiers du jeu', game: 'Lancement du jeu' },
    capture: 'Clique dans le jeu pour capturer la souris · Échap la libère · ⛶ pour le plein écran',
    released: 'Souris libérée · clique dans le jeu pour la capturer de nouveau', quit: (title) => `Quitter ${title} ? Les sauvegardes et réglages sont conservés.`,
    tips: [
      'Le premier lancement télécharge les fichiers du jeu dans ce navigateur : les suivants partent de sa copie, bien plus vite.',
      'Le plein écran (bouton en haut) donne tout l’écran au jeu ; maintiens Échap pour en sortir.',
      'En jeu, un clic capture la souris ; Échap la libère, et dans les menus la souris reste libre.',
      'Le jeu tourne entièrement dans ton navigateur, depuis ses fichiers d’origine : rien n’est installé.',
    ],
    saveFailed: 'La sauvegarde navigateur a échoué. Garde cette page ouverte pour réessayer.', stopped: 'Partie terminée. Les sauvegardes et réglages sont conservés.',
    cannotSave: 'Enregistrement impossible : ', lost: 'Connexion au serveur multijoueur perdue : rejoins-le depuis le menu multijoueur du jeu (parties LAN).',
    engineFiles: 'Ressources du moteur indisponibles', restart: 'Relancer le jeu', paused: 'en pause', loadingShort: 'chargement',
  },
};
const lang = pickLang(), S = STRINGS[lang] ?? STRINGS.en;
document.documentElement.lang = lang;
const $ = id => document.getElementById(id);
for (const [id, key] of [['tbGames', 'games'], ['tbFull', 'fullscreen'], ['nameLabel', 'name'], ['launch', 'play'], ['logLabel', 'log'], ['title', 'loading'], ['subtitle', 'subtitle'], ['status', 'preparing']]) $(id).textContent = S[key];
$('tbGames').title = S.gamesTitle; $('tbFull').title = S.fullscreenTitle; $('tbPerf').title = S.perfTitle;
for (const li of document.querySelectorAll('#loader li')) li.children[1].textContent = S.steps[li.dataset.k];
const loader = $('loader');
const logs = [], session = { state: 'loading', logs, engine: null, config: null, multiplayer: 'disconnected' };
window.portSession = session;
// Async asset loading outlives the original click. Resume the engine's audio on the next user gesture.
const audioContexts = new Set(), NativeAudioContext = globalThis.AudioContext;
if (NativeAudioContext) globalThis.AudioContext = class extends NativeAudioContext {
  constructor(...args) { super(...args); audioContexts.add(this); }
};
const resumeAudio = () => { for (const context of audioContexts) if (context.state === 'suspended') context.resume().catch(log); };
document.addEventListener('pointerdown', resumeAudio);
document.addEventListener('keydown', resumeAudio);
let engine, db, relay, timer, saving, stopped = false;
const log = line => { logs.push(String(line)); if (logs.length > 500) logs.shift(); $('log').textContent = logs.slice(-100).join('\n'); };
window.addEventListener('error', event => {
  if (stopped && (event.error === Infinity || event.error === 'unwind')) { event.preventDefault(); return; }
  if (event.error === 'unwind') return; // (the engine's normal exits from its main loop)
  log(`Page error: ${event.message}`); report('error', { message: String(event.message).slice(0, 300), where: 'page' });
});
window.addEventListener('unhandledrejection', event => { log(`Unhandled: ${event.reason?.message ?? event.reason}`); report('error', { message: String(event.reason?.message ?? event.reason).slice(0, 300), where: 'promise' }); });

// ---------------------------------------------------------------- what the server learns of a session (/api/telemetry)
// (its start, its errors with the end of the engine's log, its end with its length and frame rate; a few a session)
const telemetry = { session: crypto.randomUUID().replaceAll('-', '').slice(0, 16), started: performance.now(), sent: 0 };
function report(event, data = {}) {
  if (telemetry.sent >= 20) return; telemetry.sent++;
  const body = JSON.stringify({ session: telemetry.session, game: decodeURIComponent(location.pathname.split('/').filter(Boolean)[2] ?? ''), port: 'goldsrc', event,
    seconds: Math.round((performance.now() - telemetry.started) / 1000), state: session.state, ...data,
    env: { ua: navigator.userAgent, cores: navigator.hardwareConcurrency, memGB: navigator.deviceMemory ?? null, dpr: devicePixelRatio, screen: `${screen.width}x${screen.height}` } });
  try { if (!navigator.sendBeacon('/api/telemetry', new Blob([body], { type: 'application/json' }))) throw new Error('beacon refused'); }
  catch { fetch('/api/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {}); }
}

// ---------------------------------------------------------------- the loading screen and passing messages
const tips = S.tips; let tipTimer = null;
const showTip = (i) => { $('tip').textContent = tips[i % tips.length]; $('tip').dataset.i = String(i % tips.length); };
showTip(Math.floor(Math.random() * tips.length));
tipTimer = setInterval(() => showTip(Number($('tip').dataset.i) + 1), 9000);
const toast = (text, ms = 5000) => {
  const el = $('toast'); el.textContent = text; el.classList.remove('hidden'); el.style.opacity = '1';
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.classList.add('hidden'), 700); }, ms);
};
/** A status line: in the loading screen while it shows, then as a passing message over the game. */
const status = (text, error = false) => {
  $('status').textContent = text; $('status').classList.toggle('error', error);
  if (loader.classList.contains('hidden') && text) toast(text, error ? 9000 : 5000);
};
/** The start's steps (engine, network, files, game), each weighing its usual share of the wait; never going back. */
const progress = { weights: { engine: 0.2, files: 0.6, game: 0.2 }, parts: {}, pct: 0 };
function step(k, state, value = '', fraction = undefined) {
  const li = loader.querySelector(`li[data-k="${k}"]`); li.className = state; li.querySelector('.v').textContent = value;
  progress.parts[k] = state === 'skip' ? null : fraction ?? (state === 'done' ? 1 : progress.parts[k] ?? 0);
  let weight = 0, done = 0;
  for (const [key, f] of Object.entries(progress.parts)) if (f !== null) { weight += progress.weights[key]; done += progress.weights[key] * f; }
  progress.pct = Math.max(progress.pct, Math.min(99, Math.floor(weight ? done / weight * 100 : 0)));
  loader.querySelector('.fill').style.width = progress.pct + '%'; loader.querySelector('.pct').textContent = progress.pct + '%';
}
function hideLoader() {
  if (loader.classList.contains('hidden')) return;
  clearInterval(tipTimer);
  loader.querySelector('.fill').style.width = '100%'; loader.querySelector('.pct').textContent = '100%';
  setTimeout(() => { loader.classList.add('gone'); setTimeout(() => { loader.classList.add('hidden'); fit(); }, 600); }, 250);
  $('status').textContent = S.running;
}
const fail = error => {
  const crashed = !!engine; // (an engine that ran: its saves are kept, a new start reloads the page — a stopped engine cannot start again)
  session.state = 'error'; loader.classList.remove('hidden', 'gone'); status(S.failed + (error.message ?? error), true); log(error.stack ?? error);
  report('crash', { message: String(error.message ?? error).slice(0, 300), crashed, log: logs.slice(-30).map((l) => l.slice(0, 200)) });
  $('start').classList.remove('hidden'); $('launch').disabled = false; relay?.close(); if (timer) clearInterval(timer);
  if (crashed) { $('launch').textContent = S.restart; save().catch((e) => log('Profile save failed: ' + e.message)); }
};

// ---------------------------------------------------------------- the game's place: the window under the header
// (SDL sizes the game's screen to the canvas' size on the page: the game renders at the size it is shown, without
// bars; a mouse position maps one to one)
function fit() {
  const stage = $('stage'), canvas = $('canvas'), w = Math.max(320, stage.clientWidth), h = Math.max(240, stage.clientHeight);
  if (canvas.style.width === w + 'px' && canvas.style.height === h + 'px') return;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  // (SDL measures it again at the window's resize only: the header hidden or shown changes none)
  if (session.state === 'running') queueMicrotask(() => dispatchEvent(new Event('resize')));
}
addEventListener('resize', fit);
document.addEventListener('fullscreenchange', () => { fit(); if (!document.fullscreenElement) navigator.keyboard?.unlock?.(); });
// (the engine's glue resets the canvas' style when it sets its size: put back)
new MutationObserver(fit).observe($('canvas'), { attributes: true, attributeFilter: ['style', 'width', 'height'] });
fit();

// ---------------------------------------------------------------- the mouse
// The engine captures the mouse itself when the game takes it (SDL's relative mode: pointer lock at the next input
// event) and frees it in its menus and console, its cursor shown there. A click captures it again only while the game
// wants it — its cursor hidden: after the browser released it (Esc) — never in a menu, where the mouse must stay free.
const wantsMouse = () => session.state === 'running' && $('canvas').style.cursor === 'none';
// (how to capture the mouse: told the first time the game wants it — the game starts on its menu, where it is free)
let captureTold = false;
new MutationObserver(() => {
  if (captureTold || !wantsMouse() || document.pointerLockElement) return;
  captureTold = true; toast(S.capture, 7000);
}).observe($('canvas'), { attributes: true, attributeFilter: ['style'] });
$('canvas').addEventListener('pointerdown', () => { if (wantsMouse() && document.pointerLockElement !== $('canvas')) $('canvas').requestPointerLock()?.catch?.(() => {}); });
$('canvas').addEventListener('contextmenu', (event) => event.preventDefault());
// (the engine frees the mouse for its menus a moment after the lock ends: only a release by the player is told)
document.addEventListener('pointerlockchange', () => setTimeout(() => { if (!document.pointerLockElement && wantsMouse() && !stopped) toast(S.released, 4000); }, 150));

// ---------------------------------------------------------------- the header's frame rate
// (a frame is a main loop iteration that drew: the engine may run some without rendering, under its fps_max)
let draws = 0;
for (const type of [globalThis.WebGL2RenderingContext, globalThis.WebGLRenderingContext]) {
  if (!type) continue;
  for (const method of ['drawArrays', 'drawElements']) {
    const original = type.prototype[method];
    type.prototype[method] = function (...args) { draws++; return original.apply(this, args); };
  }
}
const perf = { frames: [], samples: [], lastDraws: 0, started: 0 };
function onFrame() {
  if (draws === perf.lastDraws) return;
  perf.lastDraws = draws; perf.frames.push(performance.now());
  if (perf.frames.length > 400) perf.frames.splice(0, perf.frames.length - 400);
  if (session.state === 'running' && ++perf.started === 10) hideLoader(); // (its first images: the game is shown)
}
setInterval(() => {
  const now = performance.now(), recent = perf.frames.filter((t) => t > now - 500);
  const gaps = recent.slice(1).map((t, i) => t - recent[i]).sort((a, b) => a - b);
  perf.samples.push({ fps: recent.length * 2, max: gaps.at(-1) ?? 0, p99: gaps[Math.floor(gaps.length * 0.99)] ?? 0 });
  if (perf.samples.length > 120) perf.samples.shift();
  renderHud();
}, 500);
/** The session's end, once: its length and frame rate. */
function endReport() { if (telemetry.ended) return; telemetry.ended = true; report('end', { frames: frameStats() }); }
/** The last minute's frame rate and slowest frames, for the session's report. */
function frameStats() {
  const a = perf.samples.filter((x) => x.fps > 0); if (!a.length) return null;
  return { fps: Math.round(a.reduce((t, x) => t + x.fps, 0) / a.length), p99: Math.round(Math.max(...a.map((x) => x.p99))) };
}
function renderHud() {
  const bar = $('topbar'), fpsEl = bar.querySelector('.fps'), sub = bar.querySelector('.sub'), a = perf.samples;
  const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
  if (session.state !== 'running' || perf.started < 10) { fpsEl.textContent = '…'; fpsEl.className = 'fps'; sub.textContent = S.loadingShort; }
  else if (document.hidden) { fpsEl.textContent = '❚❚'; fpsEl.className = 'fps'; sub.textContent = S.paused; }
  else {
    const f = ((a.at(-1)?.fps ?? 0) + (a.at(-2)?.fps ?? 0)) / 2;
    fpsEl.textContent = f.toFixed(0); fpsEl.className = 'fps ' + (f >= 29.5 ? 'good' : f >= 20 ? 'warn' : 'bad');
    const last2 = a.slice(-2);
    sub.textContent = `p99 ${ms(Math.max(...last2.map((s) => s.p99)))}\nmax ${ms(Math.max(...last2.map((s) => s.max)))}`;
  }
  const cv = bar.querySelector('canvas'), g = cv.getContext('2d'), w = cv.width, h = cv.height, top = 60, span = 120;
  const y = (v) => h - 1 - Math.min(v, top) / top * (h - 2);
  g.clearRect(0, 0, w, h); g.fillStyle = 'rgba(255,255,255,0.04)'; g.fillRect(0, 0, w, h);
  g.strokeStyle = 'rgba(255,255,255,0.25)'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(0, y(30)); g.lineTo(w, y(30)); g.stroke(); g.setLineDash([]);
  const shown = perf.started >= 10 ? a : [], x0 = w - Math.min(shown.length, span) * (w / span);
  g.strokeStyle = '#8fd18f'; g.beginPath();
  shown.slice(-span).forEach((p, i) => { const x = x0 + i * (w / span); if (i) g.lineTo(x, y(p.fps)); else g.moveTo(x, y(p.fps)); });
  g.stroke();
  g.fillStyle = '#ff6b6b'; shown.slice(-span).forEach((p, i) => { if (p.max > 50) g.fillRect(x0 + i * (w / span), 0, 2, 4); });
}

// ---------------------------------------------------------------- the installation
const name = decodeURIComponent(location.pathname.split('/').filter(Boolean)[2] ?? '');
const sessionId = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
loader.querySelector('.bg').style.backgroundImage = `url(/api/cover/${encodeURIComponent(name)})`;
let config, files, streamed;
try {
  const [manifestResponse, treeResponse] = await Promise.all([fetch(`/api/manifest/${encodeURIComponent(name)}`), fetch(`/api/tree/${encodeURIComponent(name)}`)]);
  if (!manifestResponse.ok || !treeResponse.ok) throw new Error(`HTTP ${manifestResponse.ok ? treeResponse.status : manifestResponse.status}`);
  config = session.config = await manifestResponse.json();
  if (config.runtime !== 'goldsrc') throw new Error('not a GoldSrc installation');
  files = treeFiles(await treeResponse.json());
  $('title').textContent = config.name; $('tbGame').textContent = config.name; document.title = config.name + ' · Orthros';
  // (the last nickname, else one of its own: the games' menus refuse their default "Player" for multiplayer)
  let saved = null; try { saved = localStorage.getItem('orthros.port.nickname'); } catch { /* no storage */ }
  $('name').value = saved || `Player${100 + Math.floor(Math.random() * 900)}`;
  $('launch').disabled = false;
  status(config.goldsrc.multiplayer ? S.readyServer : S.ready); session.state = 'ready';
  $('launch').focus();
} catch (error) { fail(error); }

async function save() {
  if (!db || !engine?.em || saving) return saving;
  saving = writeStorage(db, 'profile', 'files', writableSnapshot(engine.em.FS));
  try { await saving; session.lastSaveAt = Date.now(); } finally { saving = null; }
}
session.save = save;

/**
 * The multiplayer relay (/api/udp/<manifest>): every packet the engine sends goes to the version's dedicated server,
 * whatever its address — the game's LAN search (a broadcast) reaches it and lists it, its answers come as 127.0.0.1:8080.
 * Opened when the engine starts, opened again at the next packet once closed (the server closes idle ones).
 */
class Relay {
  constructor(url) { this.url = url; this.socket = null; this.queue = []; this.closed = false; this.used = 0; }
  open() {
    if (this.closed || (this.socket && this.socket.readyState <= WebSocket.OPEN)) return;
    const socket = this.socket = new WebSocket(this.url); socket.binaryType = 'arraybuffer';
    socket.onopen = () => { session.multiplayer = 'connected'; for (const data of this.queue.splice(0)) socket.send(data); };
    socket.onmessage = (event) => { this.used = performance.now(); engine.net.incoming.enqueue({ data: new Uint8Array(event.data), ip: [127, 0, 0, 1], port: 8080 }); };
    socket.onclose = () => {
      session.multiplayer = 'disconnected';
      // (told only when it was in use: a game on the server loses its connection, the next packet opens a new one)
      if (!this.closed && !stopped && performance.now() - this.used < 5000) status(S.lost, true);
    };
  }
  send(data) {
    this.open();
    if (this.socket.readyState === WebSocket.OPEN) { if (this.socket.bufferedAmount < 1024 * 1024) this.socket.send(data); }
    else if (this.queue.length < 64) this.queue.push(data.slice());
  }
  close() { this.closed = true; this.socket?.close(); }
}

function attachNet(Net) {
  class BrowserNet extends Net {
    recvfrom(...args) {
      const result = super.recvfrom(...args);
      // The published wrapper uses 73; this Emscripten libc uses EAGAIN=6.
      // Empty nonblocking receives must not become persistent engine errors.
      if (result < 0 && this.em) this.em.setValue(this.em.Module.ccall('getErrnoLocation', 'number', [], []), 6, 'i32');
      return result;
    }
  }
  const endpoint = new URL(`/api/udp/${encodeURIComponent(name)}`, location.href); endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  relay = new Relay(endpoint);
  engine.net = new BrowserNet({ sendto: (packet) => relay.send(packet.data) });
  relay.open();
}

/** The reads the game made since the last report, to the server's learned list (sendBeacon when the page goes). */
function reportReads(beacon = false) {
  const reads = streamed?.takeReads(); if (!reads?.length) return;
  const url = `/api/prefetch/${encodeURIComponent(name)}`, body = (list) => JSON.stringify({ session: sessionId, reads: list });
  if (!beacon) { fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(reads) }).catch((error) => log('Read report failed: ' + error.message)); return; }
  for (let i = 0; i < reads.length; i += 500) navigator.sendBeacon(url, new Blob([body(reads.slice(i, i + 500))], { type: 'application/json' })); // (a beacon carries 64 KiB at most)
}

/** After the start: the files kept in this browser, then the rest of the learned list, into the engine's tree. */
async function loadInBackground(rest) {
  const t = performance.now(), jobs = (list) => list.map((e) => () => streamed.load(e.file, e.pieces).catch((error) => log(`${e.file.path}: ${error.message}`)));
  await StreamedFiles.pool(jobs(streamed.localNotLoaded()), 2);
  await StreamedFiles.pool(jobs(rest), 3);
  session.background = { ms: Math.round(performance.now() - t), ...streamed.stats };
  log(`Background loading done: ${JSON.stringify(session.background)}`);
}

// The HUD's scale (the engine's hud_scale: the width of a virtual screen the HUD is drawn on, which the engine scales to
// the game's width): none up to about 1920 × 1080, then by half steps — 1.5 at 2560 × 1440, 2.5 at 3840 × 2160 — so its
// texts and menus keep their size on a large screen instead of shrinking; 0 turns it off. Read at the engine's start.
function hudScale(width, height) {
  const factor = Math.floor(Math.min(width / 1280, height / 720) * 2) / 2;
  return factor > 1 ? Math.round(width / factor) : 0;
}

const fmtMB = (bytes) => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
$('start').addEventListener('submit', async event => {
  event.preventDefault(); if (!config || session.state === 'starting' || session.state === 'running') return;
  if (engine) { try { localStorage.setItem('orthros.port.nickname', $('name').value); } catch { /* no storage */ } location.reload(); return; }
  $('launch').disabled = true; session.state = 'starting';
  $('start').classList.add('hidden'); for (const el of loader.querySelectorAll('.progress')) el.classList.remove('hidden');
  try {
    if (!crossOriginIsolated) throw new Error(S.isolated);
    const g = config.goldsrc, base = `/engines/${encodeURIComponent(g.engine)}/`;
    step('engine', 'active'); step('files', ''); step('game', '');
    status(S.init);
    db = await openStorage(config.saveKey);
    const { Xash3D, Net, DEFAULT_SERVER_LIBRARY } = await import(base + 'engine/index.js');
    const width = $('canvas').clientWidth || 1024, height = $('canvas').clientHeight || 768;
    engine = session.engine = new Xash3D({
      canvas: $('canvas'),
      // (-dll: the engine opens the server module under the name the wrapper preloaded it with, not the one the game's
      // liblist.gam names — another name finds no library and the local server never starts; the size, the canvas'
      // on the page — SDL takes it again on every change;
      // ?debug: the engine's developer messages from its start)
      // (the HUD's scale from the largest size the game takes — full screen: the engine reads it at its start only, and
      // its virtual width still fits a smaller window)
      arguments: ['-windowed', '-noip6', '-game', g.gameDir, '-dll', DEFAULT_SERVER_LIBRARY, '-rodir', '/rodir', '-basedir', '/rwdir', '-width', String(width), '-height', String(height), ...(new URLSearchParams(location.search).has('debug') ? ['-dev', '2'] : []), '+hud_scale', String(hudScale(Math.max(width, screen.width), Math.max(height, screen.height)))],
      libraries: {
        xash: base + 'engine/xash.wasm', filesystem: base + 'engine/filesystem_stdio.wasm',
        menu: base + (g.modules.menu ?? 'engine/libmenu.wasm'), client: base + g.modules.client, server: base + g.modules.server,
        render: { gl4es: base + 'engine/libref_webgl2.wasm' }
      },
      module: { print: log, printErr: log, onAbort: reason => fail(new Error(String(reason))), postMainLoop: onFrame }
    });
    if (g.multiplayer) attachNet(Net);
    const t = performance.now();
    await engine.init();
    step('engine', 'done', `${((performance.now() - t) / 1000).toFixed(1)} s`);
    const FS = engine.em.FS;
    // (the game's writable folder, with its maps folder: files the game writes there, as its bots' navigation meshes)
    FS.mkdirTree('/rodir'); FS.mkdirTree('/rwdir/' + g.gameDir + '/maps');
    restoreSnapshot(FS, await readStorage(db, 'profile', 'files'));
    // (the game's files: its whole tree now, what earlier sessions read first loaded before the start, the rest later)
    streamed = session.files = new StreamedFiles({ name, files, log, store: {
      read: (key) => readStorage(db, 'content', key), write: (key, bytes) => writeStorage(db, 'content', key, bytes),
      keys: () => storageKeys(db, 'content'), remove: (keys) => removeStorage(db, 'content', keys) } });
    streamed.mount(FS, '/rodir');
    const t0 = performance.now();
    const [learned] = await Promise.all([fetch(`/api/prefetch/${encodeURIComponent(name)}`).then((r) => (r.ok ? r.json() : [])).catch(() => []), streamed.openLocal().catch((error) => log('Content cache unavailable: ' + error.message))]);
    const plan = learnedPlan(learned, [...streamed.files.values()]), first = plan.filter((e) => e.startup);
    const bytesOf = (e) => (e.pieces ? Math.min(e.file.size, e.pieces.length * PIECE) : e.file.size), total = first.reduce((sum, e) => sum + bytesOf(e), 0);
    let loaded = 0;
    step('files', 'active', fmtMB(0), 0);
    await StreamedFiles.pool(first.map((e) => async () => {
      await streamed.load(e.file, e.pieces); loaded += bytesOf(e);
      const f = loaded / Math.max(1, total), secs = (performance.now() - t0) / 1000;
      step('files', 'active', `${fmtMB(loaded)}${secs > 1 ? ` · ${(loaded / 1048576 / secs).toFixed(1)} MB/s` : ''}`, f); status(S.files(Math.round(f * 100)));
    }), 6);
    session.startup = { files: first.length, bytes: total, ms: Math.round(performance.now() - t0), ...streamed.stats };
    log(`Startup files: ${JSON.stringify(session.startup)}`);
    // (the release's archives the engine mounts from the game folder: its own extras by default, goldsrc.extras)
    for (const extra of g.extras ?? ['engine/valve/extras.pk3']) {
      const extrasResponse = await fetch(base + extra);
      if (!extrasResponse.ok) throw new Error(S.engineFiles);
      FS.writeFile(`/rodir/${g.gameDir}/${extra.split('/').pop()}`, new Uint8Array(await extrasResponse.arrayBuffer()));
    }
    step('files', 'done', fmtMB(total));
    FS.chdir('/rwdir');
    step('game', 'active', '', 0.2); status(S.starting);
    // (main() only schedules the engine's start: it runs once the engine's WebAssembly libraries are loaded, which
    // can be after this — no console command before it has run; the reads are learned from its start)
    const M = engine.em.Module, started = new Promise((resolve) => {
      const initialized = M.onRuntimeInitialized; M.onRuntimeInitialized = () => { streamed.start(); initialized?.(); };
      M.postRun = [...(Array.isArray(M.postRun) ? M.postRun : M.postRun ? [M.postRun] : []), resolve];
    });
    engine.main();
    await started;
    step('game', 'active', '', 0.6);
    loadInBackground(plan.filter((e) => !e.startup)).catch((error) => log('Background loading failed: ' + error.message));
    setTimeout(() => reportReads(), 30000); setInterval(() => reportReads(), 120000);
    engine.Cmd_ExecuteString('developer ' + (new URLSearchParams(location.search).has('debug') ? '1' : '0'));
    const nickname = $('name').value.replace(/[^a-zA-Z0-9 _.-]/g, '').slice(0, 24) || `Player${100 + Math.floor(Math.random() * 900)}`;
    try { localStorage.setItem('orthros.port.nickname', nickname); } catch { /* no storage */ }
    engine.Cmd_ExecuteString(`name "${nickname}"`); engine.Cmd_ExecuteString('setinfo "_vgui_menus" "0"');
    // (the game's main menu: its single player and its multiplayer — a game it creates gets the manifest's settings,
    // bots included; Orthros' server answers its LAN search)
    for (const command of g.solo?.commands ?? []) engine.Cmd_ExecuteString(command);
    session.command = command => engine.Cmd_ExecuteString(command);
    session.state = 'running'; report('start', { engine: g.engine });
    timer = setInterval(() => save().catch(error => { log('Profile save failed: ' + error.message); status(S.saveFailed, true); }), 10000);
    $('canvas').focus();
  } catch (error) { fail(error); }
});

// ---------------------------------------------------------------- the header's buttons
$('tbFull').addEventListener('click', async () => {
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch (error) { status(error.message, true); return; }
  try { await navigator.keyboard?.lock?.(['Escape']); } catch { /* keyboard lock unavailable: Esc leaves the full screen */ }
  $('canvas').focus();
  if (wantsMouse()) $('canvas').requestPointerLock()?.catch?.(() => {}); // (in the game: the mouse captured at once, as the Windows games')
});
$('tbGames').addEventListener('click', async () => {
  if (session.state !== 'running') { location.href = '/?menu'; return; }
  if (!confirm(S.quit(config?.name ?? ''))) return;
  $('tbGames').disabled = true; stopped = true; if (timer) clearInterval(timer); endReport();
  try {
    engine?.Cmd_ExecuteString('host_writeconfig'); await save();
    try { engine?.quit(); } catch (error) {
      // Emscripten ends its main loop by unwinding; this is successful shutdown.
      if (error !== Infinity && error !== 'unwind' && error?.name !== 'ExitStatus') throw error;
    }
    await save(); relay?.close(); db?.close();
    session.state = 'stopped'; status(S.stopped); location.href = '/?menu';
  } catch (error) { stopped = false; $('tbGames').disabled = false; status(S.cannotSave + (error?.message ?? String(error)), true); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) save().catch(log); });
window.addEventListener('pagehide', () => {
  if (session.state === 'running') endReport();
  stopped = true; if (timer) clearInterval(timer); relay?.close(); reportReads(true); });
