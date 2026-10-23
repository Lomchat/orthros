// The page of a GoldSrc browser port (src/host/goldsrc.js, docs/browser-ports.md), /ports/goldsrc/<manifest>/: the
// pinned engine release the manifest names (/engines/<release>/), the version's game files streamed (../port-files.js:
// the game data every Orthros game reads — what the game reads first loaded before it starts, the rest as it goes, kept
// in the browser), the writable profile (saves,
// settings) in IndexedDB under the installation's key and on the player's Orthros account (cloud-sync.js), multiplayer
// through the server's relay (/api/udp/<manifest>) for a signed-in player — the account is the player's name.
// Around the game, the frame every Orthros game has (/src/host/web/shell.js): the header (the mouse, the saves, the
// frame rate, the online games, full screen, back to the games), the loading screen, the game filling the rest of the
// window. It never loads the Win32 runtime, and nothing here names a game.
import { pickLang } from '../../host/web/lang.js';
import { createShell, lockKeys } from '../../host/web/shell.js';
import { escapeToGame } from '../../host/web/escape.js';
import { beacon, canvasGl, portPerf } from '../../host/web/perf-page.js';
import { CloudSave } from '../../host/web/cloud-sync.js';
import { openStorage, readStorage, writeStorage, writableSnapshot, restoreSnapshot } from './storage.js';
import { treeFiles, languageFiles } from '../../vfs/game-tree.js';
import { openPortFiles } from '../port-files.js';
import { phaseOnRead } from '../../vfs/emscripten-files.js';
import { createLobby, roomAddress } from './lobby.js';

const STRINGS = {
  en: {
    lobby: '◉ Online games', lobbyTitle: 'the games running on the servers: join one, or create yours',
    subtitle: 'its original files, on a game engine in your browser',
    failed: 'The game could not start: ', isolated: 'This page must be served with the browser isolation headers',
    init: 'Starting the engine…', files: (pct) => `Loading the files · ${pct} %`, account: 'Checking your account\'s saves…',
    starting: 'Starting the game…', running: 'Game started. Click in the game to play.',
    steps: { engine: 'Starting the engine', files: 'Downloading the game files', game: 'Starting the game' },
    capture: 'Click the game to capture the mouse · Esc goes to the game (in full screen, twice releases the mouse) · ⛶ for full screen',
    released: 'Mouse released · click the game to capture it again',
    tips: [
      'The first launch downloads the game files into this browser: the next ones start from its own copy, much faster.',
      'Full screen (button above) gives the game the whole screen; hold Esc to leave it.',
      'In the game, a click captures the mouse; Esc releases it, and in the menus the mouse is free.',
      'Signed in to Orthros, your saves follow you, and the game\'s multiplayer menu lists the online games.',
      'The game runs entirely in your browser, from its original files: nothing is installed.',
    ],
    saveFailed: 'Saving in the browser failed. Keep this page open to retry.',
    lost: 'Connection to the multiplayer server lost: join it again from the game\'s multiplayer menu (LAN games).',
    engineFiles: 'Engine resources unavailable', restart: 'Restart the game',
    needAccount: 'Multiplayer needs an Orthros account', needAccountText: 'Sign in (or create an account) to join or create online games: your account is your name in the game.',
    signIn: 'Sign in', later: 'Not now', online: (u) => `Signed in as ${u}: the online games are open.`,
    lateTitle: 'A save on your account', lateText: (t) => `Your account already has a save of ${t}, different from this browser's. Restart with your account's save, or send this browser's one over it (the account's stays in its history)?`,
    lateAccount: 'Restart with the account\'s save', lateDevice: 'Keep this browser\'s save',
  },
  fr: {
    lobby: '◉ Parties en ligne', lobbyTitle: 'les parties en cours sur les serveurs : en rejoindre une, ou créer la tienne',
    subtitle: 'ses fichiers d’origine, sur un moteur de jeu dans ton navigateur',
    failed: 'Le jeu n’a pas pu démarrer : ', isolated: 'Cette page doit être servie avec les en-têtes d’isolation du navigateur',
    init: 'Démarrage du moteur…', files: (pct) => `Chargement des fichiers · ${pct} %`, account: 'Vérification des sauvegardes de ton compte…',
    starting: 'Lancement du jeu…', running: 'Partie lancée. Clique dans le jeu pour jouer.',
    steps: { engine: 'Démarrage du moteur', files: 'Téléchargement des fichiers du jeu', game: 'Lancement du jeu' },
    capture: 'Clique dans le jeu pour capturer la souris · Échap va au jeu (en plein écran, deux fois libère la souris) · ⛶ pour le plein écran',
    released: 'Souris libérée · clique dans le jeu pour la capturer de nouveau',
    tips: [
      'Le premier lancement télécharge les fichiers du jeu dans ce navigateur : les suivants partent de sa copie, bien plus vite.',
      'Le plein écran (bouton en haut) donne tout l’écran au jeu ; maintiens Échap pour en sortir.',
      'En jeu, un clic capture la souris ; Échap la libère, et dans les menus la souris reste libre.',
      'Connecté à Orthros, tes sauvegardes te suivent, et le menu multijoueur du jeu liste les parties en ligne.',
      'Le jeu tourne entièrement dans ton navigateur, depuis ses fichiers d’origine : rien n’est installé.',
    ],
    saveFailed: 'La sauvegarde navigateur a échoué. Garde cette page ouverte pour réessayer.',
    lost: 'Connexion au serveur multijoueur perdue : rejoins-le depuis le menu multijoueur du jeu (parties LAN).',
    engineFiles: 'Ressources du moteur indisponibles', restart: 'Relancer le jeu',
    needAccount: 'Le multijoueur demande un compte Orthros', needAccountText: 'Connecte-toi (ou crée un compte) pour rejoindre ou créer des parties en ligne : ton compte est ton nom dans le jeu.',
    signIn: 'Se connecter', later: 'Plus tard', online: (u) => `Connecté en tant que ${u} : les parties en ligne sont ouvertes.`,
    lateTitle: 'Une sauvegarde sur ton compte', lateText: (t) => `Ton compte a déjà une sauvegarde de ${t}, différente de celle de ce navigateur. Relancer avec celle du compte, ou envoyer celle de ce navigateur par-dessus (celle du compte reste dans son historique) ?`,
    lateAccount: 'Relancer avec celle du compte', lateDevice: 'Garder celle de ce navigateur',
  },
};
const lang = pickLang(), S = STRINGS[lang] ?? STRINGS.en;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const logs = [], session = { state: 'loading', logs, engine: null, config: null, multiplayer: 'disconnected' };
window.portSession = session;
let shell = null, cloud = null;
// Async asset loading outlives the original click. Resume the engine's audio on the next user gesture.
const audioContexts = new Set(), NativeAudioContext = globalThis.AudioContext;
if (NativeAudioContext) globalThis.AudioContext = class extends NativeAudioContext {
  constructor(...args) { super(...args); audioContexts.add(this); }
};
// (the engine's output measured: its level the last seconds, for the "sound blocked" hint and the session's report)
const audioMeter = { peak: 0, heard: 0 };
const NativeConnect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (target, ...rest) {
  if (target instanceof AudioDestinationNode && !target.context.__meter) {
    const meter = target.context.__meter = target.context.createAnalyser(); meter.fftSize = 1024;
    NativeConnect.call(this, meter);
  } else if (target instanceof AudioDestinationNode) NativeConnect.call(this, target.context.__meter);
  return NativeConnect.call(this, target, ...rest);
};
setInterval(() => {
  const buf = new Float32Array(1024); let peak = 0;
  for (const context of audioContexts) { if (!context.__meter) continue; context.__meter.getFloatTimeDomainData(buf); for (const v of buf) peak = Math.max(peak, Math.abs(v)); }
  audioMeter.peak = Math.max(audioMeter.peak * 0.9, peak); if (peak > 0.01) audioMeter.heard = performance.now();
}, 250);
const audioState = () => ({ contexts: [...audioContexts].map((c) => c.state), heard: audioMeter.heard ? Math.round((performance.now() - audioMeter.heard) / 1000) : null });
const resumeAudio = () => {
  for (const context of audioContexts) if (context.state !== 'running' && context.state !== 'closed') context.resume().then(() => soundHint(), log);
  soundHint();
};
document.addEventListener('pointerdown', resumeAudio, { capture: true });
document.addEventListener('keydown', resumeAudio, { capture: true });
// (the browser keeps the sound off until the page is used: told, with a button, while it is)
function soundHint() {
  const blocked = session.state === 'running' && [...audioContexts].some((c) => c.state === 'suspended');
  shell?.sound.classList.toggle('hidden', !blocked);
}
setInterval(soundHint, 1000);
let engine, db, relay, timer, cloudTimer, saving, stopped = false;
function log(line) { logs.push(String(line)); if (logs.length > 500) logs.shift(); shell?.log(String(line)); }
window.addEventListener('error', event => {
  if (stopped && (event.error === Infinity || event.error === 'unwind')) { event.preventDefault(); return; }
  if (event.error === 'unwind') return; // (the engine's normal exits from its main loop)
  log(`Page error: ${event.message}`); report('error', { message: String(event.message).slice(0, 300), where: 'page' });
});
window.addEventListener('unhandledrejection', event => { log(`Unhandled: ${event.reason?.message ?? event.reason}`); report('error', { message: String(event.reason?.message ?? event.reason).slice(0, 300), where: 'promise' }); });

// ---------------------------------------------------------------- what the server learns of a session (/api/telemetry)
// (its start, its errors with the end of the engine's log, its end with its length and frame rate; a few a session)
const telemetry = { session: crypto.randomUUID().replaceAll('-', '').slice(0, 16), started: performance.now(), sent: 0 };
/** the passive session record (perf-page.js: every 2 min of play and at the end, docs/real-machine-bench.md) */
let perfRecord = null;
function report(event, data = {}) {
  if (telemetry.sent >= 20) return; telemetry.sent++;
  const body = JSON.stringify({ session: telemetry.session, game: decodeURIComponent(location.pathname.split('/').filter(Boolean)[2] ?? ''), port: 'goldsrc', event, ...(params.get('benchrun') ? { bench: params.get('benchrun') } : {}), // (a bench suite's session: bench-suite.js)
    seconds: Math.round((performance.now() - telemetry.started) / 1000), state: session.state, ...data,
    env: { ua: navigator.userAgent, cores: navigator.hardwareConcurrency, memGB: navigator.deviceMemory ?? null, dpr: devicePixelRatio, screen: `${screen.width}x${screen.height}` } });
  beacon(body);
}

// ---------------------------------------------------------------- the loading screen and passing messages
const toast = (text, ms = 5000) => shell?.toast(text, ms);
/** A status line: in the loading screen while it shows, then as a passing message over the game. */
const status = (text, error = false) => shell?.phase(text, error);
/** The start's steps (engine, files, game), each weighing its usual share of the wait; never going back. */
const progress = { weights: { engine: 0.2, files: 0.6, game: 0.2 }, parts: {} };
function step(k, state, value = '', fraction = undefined) {
  shell.step(k, state, value);
  progress.parts[k] = state === 'skip' ? null : fraction ?? (state === 'done' ? 1 : progress.parts[k] ?? 0);
  let weight = 0, done = 0;
  for (const [key, f] of Object.entries(progress.parts)) if (f !== null) { weight += progress.weights[key]; done += progress.weights[key] * f; }
  shell.progress(weight ? done / weight * 100 : 0);
}
function hideLoader() {
  if (!shell || shell.loader.classList.contains('hidden')) return;
  shell.hideLoader();
  shell.running = true; shell.watchPointer(document);
  gameData?.mark('playable'); // (the game shown: what it read until now is its launch set, src/vfs/launch-set.js)
  status(S.running);
  if (lobbyOverlay.classList.contains('hidden')) lobby?.hide();
}
const fail = error => {
  const crashed = !!engine; // (an engine that ran: its saves are kept, a new start reloads the page — a stopped engine cannot start again)
  session.state = 'error'; shell?.showLoader(); status(S.failed + (error.message ?? error), true); log(error.stack ?? error);
  report('crash', { message: String(error.message ?? error).slice(0, 300), crashed, log: logs.slice(-30).map((l) => l.slice(0, 200)) });
  relay?.close(); if (timer) clearInterval(timer);
  if (shell) shell.choices.replaceChildren(Object.assign(document.createElement('div'), { className: 'acts' }));
  const again = document.createElement('button'); again.type = 'button'; again.className = 'primary'; again.textContent = S.restart; again.onclick = () => location.reload();
  shell?.choices.querySelector('.acts')?.append(again);
  if (crashed) save().then(() => cloud?.push()).catch((e) => log('Profile save failed: ' + e.message));
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
document.addEventListener('fullscreenchange', fit);
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
escapeToGame(window); // (the first Escape to the game, the next frees the mouse)
$('canvas').addEventListener('pointerdown', () => { if (wantsMouse() && document.pointerLockElement !== $('canvas')) $('canvas').requestPointerLock()?.catch?.(() => {}); });
$('canvas').addEventListener('contextmenu', (event) => event.preventDefault());
// (the engine frees the mouse for its menus a moment after the lock ends: only a release by the player is told)
document.addEventListener('pointerlockchange', () => setTimeout(() => { if (!document.pointerLockElement && wantsMouse() && !stopped) toast(S.released, 4000); }, 150));
/** The header's mouse indicator clicked: the game gets the mouse when it wants it, else the keys. */
function giveMouse() {
  $('canvas').focus();
  if (wantsMouse()) $('canvas').requestPointerLock()?.catch?.(() => {}); else toast(S.capture, 5000);
}

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
  shell?.setFps(perf.samples, session.state !== 'running' || perf.started < 10 ? 'loading' : document.hidden ? 'paused' : 'running');
}, 500);
/** The session's end, once: its length and frame rate. */
function endReport() { perfRecord?.end(); if (telemetry.ended) return; telemetry.ended = true; report('end', { frames: frameStats(), audio: audioState() }); }
/** The last minute's frame rate and slowest frames, for the session's report. */
function frameStats() {
  const a = perf.samples.filter((x) => x.fps > 0); if (!a.length) return null;
  return { fps: Math.round(a.reduce((t, x) => t + x.fps, 0) / a.length), p99: Math.round(Math.max(...a.map((x) => x.p99))) };
}

// ---------------------------------------------------------------- the player: the Orthros account
/** The name in the game: the account's (letters, digits, '.', '_', '-'), or a guest's for a player not signed in. */
const guestName = `Guest${100 + Math.floor(Math.random() * 900)}`;
const playerName = () => (shell?.account?.username ?? '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 24) || guestName;
const signedIn = () => !!shell?.account || shell?.accounts === false;
/** Multiplayer without an account: asked to sign in (the account window), or not now. */
async function needAccount() {
  const choice = await shell.ask({ title: S.needAccount, text: S.needAccountText, buttons: [{ value: 'in', label: S.signIn, primary: true }, { value: null, label: S.later }] });
  if (choice) window.orthrosData?.open?.('account');
}

// ---------------------------------------------------------------- the installation
const name = decodeURIComponent(location.pathname.split('/').filter(Boolean)[2] ?? '');
const sessionId = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
let config, tree, files, gameData, lobby = null, pendingConnect = null;
/** A room of the lobby joined: the engine told to connect, or once it runs. */
function joinRoom(room) {
  const address = roomAddress(room.index);
  closeLobby();
  if (session.state === 'running') { log(`Joining ${room.name} (${address})`); engine.Cmd_ExecuteString(`connect ${address}`); $('canvas').focus(); return; }
  pendingConnect = address;
}
// (over the game: the header's button opens it; the keys typed in it stay its own — the engine listens to the page's)
const lobbyOverlay = $('lobbyOverlay');
const lobbyButton = Object.assign(document.createElement('button'), { type: 'button', id: 'tbLobby', className: 'pill rooms hidden', textContent: S.lobby, title: S.lobbyTitle });
function openLobby() {
  if (!lobby) return;
  document.exitPointerLock?.(); lobbyOverlay.querySelector('.panel').prepend(lobby.el); lobby.el.classList.remove('hidden'); lobbyOverlay.classList.remove('hidden'); lobby.show();
  lobbyOverlay.querySelector('.close').focus(); // (the keys typed then are the overlay's)
}
function closeLobby() {
  if (lobbyOverlay.classList.contains('hidden')) return;
  lobbyOverlay.classList.add('hidden'); lobby?.hide();
  // (before the game shows: back in the loading screen, among its choices)
  if (session.state !== 'running' || !shell.loader.classList.contains('hidden')) { shell.choices.append(lobby.el); lobby.show(); }
  else $('canvas').focus();
}
lobbyButton.addEventListener('click', () => (lobbyOverlay.classList.contains('hidden') ? openLobby() : closeLobby()));
lobbyOverlay.addEventListener('click', (event) => { if (event.target === lobbyOverlay) closeLobby(); });
lobbyOverlay.querySelector('.close').addEventListener('click', closeLobby);
// (while it shows, no key reaches the engine: keys aimed elsewhere are caught before the engine's listeners; those of
// the overlay's own controls reach them, then stop at the overlay)
for (const type of ['keydown', 'keyup', 'keypress']) {
  addEventListener(type, (event) => {
    if (lobbyOverlay.classList.contains('hidden')) return;
    // (Escape: the creation form first, when it shows, then the overlay)
    if (type === 'keydown' && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!lobby?.closeForm()) closeLobby(); return; }
    if (!lobbyOverlay.contains(event.target)) { event.stopImmediatePropagation(); lobbyOverlay.querySelector('.close').focus(); }
  }, { capture: true });
  lobbyOverlay.addEventListener(type, (event) => event.stopPropagation());
}

// ---------------------------------------------------------------- the profile on the account (cloud-sync.js)
// (what the account keeps: the game's writable folder less what the engine makes again — logs, screenshots, bots'
// navigation meshes, the decals' cache)
const KEEP = (path) => !/(^|\/)(screenshots|logs)\//i.test(path) && !/\.(log|nav|hpk)$/i.test(path);
const toCloud = (list) => (list ?? []).filter((f) => f.path.startsWith('/rwdir/')).map((f) => ({ path: f.path.slice(7), data: f.data })).filter((f) => KEEP(f.path));
function newCloud(username) {
  return new CloudSave({
    game: name, user: username, onStatus: (s) => shell.setSave(s),
    read: async () => toCloud(engine?.em && session.state === 'running' ? writableSnapshot(engine.em.FS) : await readStorage(db, 'profile', 'files')),
    // (before the engine starts only: the previous profile kept aside in the same store)
    write: async (list) => {
      const old = await readStorage(db, 'profile', 'files');
      if (old?.length) await writeStorage(db, 'profile', `aside-${new Date().toISOString()}`, old);
      await writeStorage(db, 'profile', 'files', list.map((f) => ({ path: '/rwdir/' + f.path, data: f.data })));
    },
  });
}
/**
 * Signed in while the game runs: its name and multiplayer opened; its profile sent to the account, unless the account
 * has another one — then the player chooses: restart with the account's, or this browser's sent over it.
 */
async function lateSignIn(user) {
  if (engine && session.state === 'running') engine.Cmd_ExecuteString(`name "${playerName()}"`);
  if (relay) { relay.enabled = true; relay.open(); }
  if (config?.goldsrc.multiplayer) toast(S.online(user.username), 5000);
  if (cloud || !db) return;
  cloud = newCloud(user.username);
  const head = await cloud.remoteHead().catch(() => null);
  cloud.remoteHash = head;
  if (!head) { if (session.state === 'running') await save(); cloud.push(); return; }
  const choice = await shell.ask({ title: S.lateTitle, text: S.lateText(config.name), buttons: [{ value: 'account', label: S.lateAccount, primary: true }, { value: 'device', label: S.lateDevice }] });
  if (choice === 'account') { stopped = true; if (timer) clearInterval(timer); if (cloudTimer) clearInterval(cloudTimer); try { const remote = await cloud.fetchRemote(); if (remote) await cloud.applyRemote(remote); } finally { location.reload(); } }
  else if (choice === 'device') { await save(); cloud.resolve('device'); }
  else cloud.set({ state: 'conflict' });
}

async function save() {
  if (!db || !engine?.em || saving || stopped) return saving; // (stopped: the page goes, or the account's copy replaces this one)
  saving = writeStorage(db, 'profile', 'files', writableSnapshot(engine.em.FS));
  try { await saving; session.lastSaveAt = Date.now(); } finally { saving = null; }
}
session.save = save;

/**
 * The multiplayer relay (/api/udp/<manifest>?rooms): the version's servers, each packet tagged with its room in its
 * first byte. The engine reaches room i at 10.87.0.<i+1>:27015 (lobby.js roomAddress; 127.0.0.1:8080 too, room 0); a
 * broadcast — the game's LAN search — goes to every room, and each answers from its own address, so the game's own
 * server list shows them all. Opened when the engine starts with a signed-in player (`enabled`), opened again at the
 * next packet once closed (the server closes idle ones).
 */
class Relay {
  constructor(url, enabled) { this.url = url; this.enabled = enabled; this.socket = null; this.queue = []; this.closed = false; this.used = 0; this.from = new Map(); }
  open() {
    if (this.closed || !this.enabled || (this.socket && this.socket.readyState <= WebSocket.OPEN)) return;
    const socket = this.socket = new WebSocket(this.url); socket.binaryType = 'arraybuffer';
    socket.onopen = () => { session.multiplayer = 'connected'; for (const data of this.queue.splice(0)) socket.send(data); };
    socket.onmessage = (event) => {
      const bytes = new Uint8Array(event.data); if (bytes.length < 2) return;
      this.used = performance.now();
      // (an answer comes from the address the engine used for that room: its connection knows no other)
      const [ip, port] = this.from.get(bytes[0]) ?? [[10, 87, 0, bytes[0] + 1], 27015];
      engine.net.incoming.enqueue({ data: bytes.subarray(1), ip, port });
    };
    socket.onclose = () => {
      session.multiplayer = 'disconnected';
      // (told only when it was in use: a game on the server loses its connection, the next packet opens a new one)
      if (!this.closed && !stopped && performance.now() - this.used < 5000) status(S.lost, true);
    };
  }
  /** The room a packet goes to: 255 for a broadcast; null for an address that is none of theirs (dropped). */
  room(ip, port) {
    if (ip[3] === 255 || (ip[0] === 255 && ip[1] === 255)) return 255;
    if (ip[0] === 10 && ip[1] === 87 && ip[2] === 0 && ip[3] >= 1 && ip[3] <= 9) return ip[3] - 1;
    if (ip[0] === 127 && ip[1] === 0 && ip[2] === 0 && ip[3] === 1 && port === 8080) return 0;
    return null;
  }
  send(packet) {
    if (!this.enabled) return; // (no account: no multiplayer — the game's LAN search finds nothing)
    const index = this.room(packet.ip, packet.port);
    if (index === null) return;
    if (index !== 255) this.from.set(index, [[...packet.ip], packet.port]);
    const data = new Uint8Array(packet.data.length + 1); data[0] = index; data.set(packet.data, 1);
    this.open();
    if (this.socket.readyState === WebSocket.OPEN) { if (this.socket.bufferedAmount < 1024 * 1024) this.socket.send(data); }
    else if (this.queue.length < 64) this.queue.push(data);
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
  const endpoint = new URL(`/api/udp/${encodeURIComponent(name)}?rooms`, location.href); endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  relay = new Relay(endpoint, signedIn());
  engine.net = new BrowserNet({ sendto: (packet) => relay.send(packet) });
  relay.open();
}

// The HUD's scale (the engine's hud_scale: the width of a virtual screen the HUD is drawn on, which the engine scales to
// the game's width): none up to about 1920 × 1080, then by half steps — 1.5 at 2560 × 1440, 2.5 at 3840 × 2160 — so its
// texts and menus keep their size on a large screen instead of shrinking; 0 turns it off. Read at the engine's start.
function hudScale(width, height) {
  const factor = Math.floor(Math.min(width / 1280, height / 720) * 2) / 2;
  return factor > 1 ? Math.round(width / factor) : 0;
}

/** The game's language: the one chosen on the home screen (?gameLang=, else remembered), among the version's. */
function gameLanguage(man) {
  const options = man.languages ?? [];
  let wanted = params.get('gameLang'); if (!options.includes(wanted)) { try { wanted = localStorage.getItem('orthros.gameLanguage.' + (man.gameId ?? name)); } catch { wanted = null; } }
  return options.includes(wanted) ? wanted : options.includes(lang) ? lang : options.includes('en') ? 'en' : options[0] ?? null;
}

const fmtMB = (bytes) => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
/** The game started at once: the account's saves first, then the engine, the files, the game's own start. */
async function start() {
  session.state = 'starting';
  perfRecord ??= portPerf({ runtime: 'goldsrc', game: name, session: telemetry.session, version: config.version ?? null, bench: params.get('benchrun'), phase: () => session.state, data: () => (gameData ? { waits: gameData.stats.misses, ms: gameData.stats.stallMs } : null), gl: () => canvasGl($('canvas')), draws: () => draws });
  if (!crossOriginIsolated) throw new Error(S.isolated);
  const g = config.goldsrc, base = `/engines/${encodeURIComponent(g.engine)}/`, language = gameLanguage(config);
  step('engine', 'active'); step('files', ''); step('game', '');
  db = await openStorage(config.saveKey);
  const who = await shell.ready;
  if (who.user) {
    status(S.account);
    cloud = newCloud(who.user.username);
    const what = await cloud.pull().catch((e) => { log('Account saves: ' + e.message); return 'offline'; });
    if (what === 'conflict') await shell.resolveConflict(cloud);
  }
  status(S.init);
  const { Xash3D, Net, DEFAULT_SERVER_LIBRARY } = await import(base + 'engine/index.js');
  const width = $('canvas').clientWidth || 1024, height = $('canvas').clientHeight || 768;
  // (a language's own arguments and folders, goldsrc.languages.<code> — the engine's, as the version's release has them)
  const own = g.languages?.[language] ?? {};
  engine = session.engine = new Xash3D({
    canvas: $('canvas'),
    // (-dll: the engine opens the server module under the name the wrapper preloaded it with, not the one the game's
    // liblist.gam names — another name finds no library and the local server never starts; the size, the canvas'
    // on the page — SDL takes it again on every change; ?debug: the engine's developer messages from its start)
    // (the HUD's scale from the largest size the game takes — full screen: the engine reads it at its start only, and
    // its virtual width still fits a smaller window)
    arguments: ['-windowed', '-noip6', '-game', g.gameDir, '-dll', DEFAULT_SERVER_LIBRARY, '-rodir', '/rodir', '-basedir', '/rwdir', '-width', String(width), '-height', String(height), ...(own.args ?? []), ...(params.has('debug') ? ['-dev', '2'] : []), '+hud_scale', String(hudScale(Math.max(width, screen.width), Math.max(height, screen.height)))],
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
  // (the game's files: its whole tree now — a language's folders over the ones they translate —, what earlier sessions
  // read first loaded before the start, the rest later)
  const shown = languageFiles(files, own.overlays, Object.values(g.languages ?? {}).flatMap((l) => Object.keys(l.overlays ?? {})));
  const t0 = performance.now();
  step('files', 'active', fmtMB(0), 0);
  let nodes;
  ({ data: gameData, nodes } = await openPortFiles({ name, tree, files: shown, FS, root: '/rodir', session: sessionId, lang: language, log, db,
    onCopy: (bytes) => step('files', 'active', fmtMB(bytes), 0), onProgress: (progress) => shell.setData(progress) }));
  session.files = gameData;
  // (each map the engine loads — its .bsp read — a phase of the game data: the server learns what each map's load reads,
  // in its order, and the next sessions load it ahead — GameData.phase)
  phaseOnRead(FS, nodes, gameData, (p) => /\/maps\/([^/]+)\.bsp$/i.exec(p)?.[1].toLowerCase() ?? null);
  const loaded = await gameData.startup((p) => {
    const f = p.total ? p.bytes / p.total : 1, secs = (performance.now() - t0) / 1000;
    step('files', 'active', `${fmtMB(p.bytes)}${secs > 1 ? ` · ${(p.bytes / 1048576 / secs).toFixed(1)} MB/s` : ''}`, f); status(S.files(Math.round(f * 100)));
  });
  session.startup = { ...gameData.snapshot(), startupBytes: loaded.total, ms: Math.round(performance.now() - t0) };
  log(`Startup files: ${JSON.stringify(session.startup)}`);
  // (the release's archives the engine mounts from the game folder: its own extras by default, goldsrc.extras)
  for (const extra of [...(g.extras ?? ['engine/valve/extras.pk3']), ...(own.extras ?? [])]) {
    const extrasResponse = await fetch(base + extra);
    if (!extrasResponse.ok) throw new Error(S.engineFiles);
    FS.writeFile(`/rodir/${g.gameDir}/${extra.split('/').pop()}`, new Uint8Array(await extrasResponse.arrayBuffer()));
  }
  step('files', 'done', fmtMB(loaded.total));
  FS.chdir('/rwdir');
  step('game', 'active', '', 0.2); status(S.starting);
  // (main() only schedules the engine's start: it runs once the engine's WebAssembly libraries are loaded, which
  // can be after this — no console command before it has run; the reads are learned from its start)
  const M = engine.em.Module, started = new Promise((resolve) => {
    const initialized = M.onRuntimeInitialized; M.onRuntimeInitialized = () => { gameData.start(); initialized?.(); };
    M.postRun = [...(Array.isArray(M.postRun) ? M.postRun : M.postRun ? [M.postRun] : []), resolve];
  });
  engine.main();
  await started;
  step('game', 'active', '', 0.6);
  engine.Cmd_ExecuteString('developer ' + (params.has('debug') ? '1' : '0'));
  // (the renderer's error checks — glGetError after its passes each frame and after each texture upload — only with
  // ?debug: each one waits for the browser's GPU process, about 10 a frame; docs/browser-ports.md, "Measured")
  engine.Cmd_ExecuteString('gl_check_errors ' + (params.has('debug') ? '1' : '0'));
  // (the world's surfaces from buffers the renderer fills once a map, gl_vbo — not re-sent a polygon at a time with
  // its own buffer upload and state: about 85 draws a frame instead of 700 in Counter-Strike; ?vbo=0, or a manifest's
  // commands, turn it off)
  engine.Cmd_ExecuteString('gl_vbo ' + (params.get('vbo') === '0' ? '0' : '1'));
  engine.Cmd_ExecuteString(`name "${playerName()}"`); engine.Cmd_ExecuteString('setinfo "_vgui_menus" "0"');
  // (the game's main menu: its single player and its multiplayer — a game it creates gets the manifest's settings,
  // bots included; Orthros' server answers its LAN search; the language's own commands)
  for (const command of [...(g.solo?.commands ?? []), ...(own.commands ?? [])]) engine.Cmd_ExecuteString(command);
  // (a room chosen in the lobby during the loading: joined at once)
  if (pendingConnect) { log(`Joining ${pendingConnect}`); engine.Cmd_ExecuteString(`connect ${pendingConnect}`); pendingConnect = null; }
  session.command = command => engine.Cmd_ExecuteString(command);
  session.state = 'running'; report('start', { engine: g.engine, signedIn: !!shell.account });
  setTimeout(() => report('audio', audioState()), 60000); // (a minute in: is the game heard?)
  timer = setInterval(() => save().catch(error => { log('Profile save failed: ' + error.message); status(S.saveFailed, true); }), 10000);
  // (the account's copy: a minute after a change at most — CloudSave sends only what changed)
  cloudTimer = setInterval(() => { if (cloud && session.state === 'running') cloud.push(); }, 60000);
  $('canvas').focus();
}

/**
 * Back to the games: the game's settings written, the profile kept here and on the account; false when it could not
 * be sent. (The engine is not asked to quit: the page goes, and this release's quit can stop on an error of its own.)
 */
async function quit() {
  if (session.state !== 'running') return true;
  try {
    engine?.Cmd_ExecuteString('host_writeconfig'); await save();
    const sent = cloud ? await cloud.push() : null;
    return !sent || !['error', 'toobig', 'conflict'].includes(sent.state);
  } catch (error) { log('Quit: ' + (error?.message ?? error)); return false; }
}

async function fullscreen() {
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch (error) { status(error.message, true); return; }
  await lockKeys();
  $('canvas').focus();
  if (wantsMouse()) $('canvas').requestPointerLock()?.catch?.(() => {}); // (in the game: the mouse captured at once, as the Windows games')
}

try {
  const [manifestResponse, treeResponse] = await Promise.all([fetch(`/api/manifest/${encodeURIComponent(name)}`), fetch(`/api/tree/${encodeURIComponent(name)}`)]);
  if (!manifestResponse.ok || !treeResponse.ok) throw new Error(`HTTP ${manifestResponse.ok ? treeResponse.status : manifestResponse.status}`);
  config = session.config = await manifestResponse.json();
  if (config.runtime !== 'goldsrc') throw new Error('not a GoldSrc installation');
  tree = await treeResponse.json(); files = treeFiles(tree);
  shell = createShell({
    title: config.name, version: config.version, gameLanguage: gameLanguage(config), cover: `/api/cover/${encodeURIComponent(name)}`, subtitle: S.subtitle,
    steps: Object.entries(S.steps).map(([k, label]) => ({ k, label })), tips: S.tips, extras: [lobbyButton],
    onQuit: quit, onFullscreen: fullscreen, onMouse: giveMouse, onSignedIn: lateSignIn, saves: () => cloud,
    onLoaderHidden: fit,
  });
  shell.sound.addEventListener('click', resumeAudio);
  // (the multiplayer lobby: among the loading screen's choices while the game loads, over the game after it)
  if (config.goldsrc.multiplayer) {
    lobby = createLobby({ name, lang, log, nickname: playerName, signedIn, needAccount, onJoin: joinRoom });
    shell.choices.append(lobby.el); lobby.show();
    lobbyButton.classList.remove('hidden');
  }
  await start();
} catch (error) { if (shell) fail(error); else document.body.textContent = S.failed + (error.message ?? error); }

document.addEventListener('visibilitychange', () => { if (document.hidden && session.state === 'running') save().then(() => cloud?.push()).catch(log); });
window.addEventListener('pagehide', () => {
  if (session.state === 'running') endReport();
  stopped = true; if (timer) clearInterval(timer); relay?.close(); gameData?.close(); });
