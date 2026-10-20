// The page of an re3 browser port (src/host/re3.js, docs/browser-ports.md "re3 ports"), /ports/re3/<manifest>/: the
// pinned engine release the manifest names (/engines/<release>/: an Emscripten ES module — SDL2 on WebGL 2, OpenAL on
// WebAudio, JSPI), the version's game files streamed into the game's folder with the release's own over them
// (../goldsrc/files.js: what the game reads first loaded before it starts, the rest as it goes; kept in IndexedDB), and
// the files the engine writes there — saves, settings, its ini file — as the player's profile (profile.js), in
// IndexedDB under the installation's key and on the player's Orthros account (cloud-sync.js). A version with `mmo` has
// a shared world on the server besides (docs/mmo.md): the engine reaches it through Module.orthrosNet, the shared link
// (../../host/web/mmo-link.js) and what the engine asks of the page (who plays, a sign-in, its test hooks).
// Around the game, the frame every Orthros game has (/src/host/web/shell.js): the header (the mouse, the saves, the
// frame rate, full screen, back to the games), the loading screen, the game filling the rest of the window. It never
// loads the Win32 runtime, and nothing here names a game.
import { pickLang } from '../../host/web/lang.js';
import { createShell, lockKeys } from '../../host/web/shell.js';
import { escapeToGame } from '../../host/web/escape.js';
import { CloudSave } from '../../host/web/cloud-sync.js';
import { onAccountChange } from '../../host/web/account.js';
import { createMmoLink, LINK } from '../../host/web/mmo-link.js';
import { openStorage, readStorage, writeStorage, writeManyStorage, storageKeys, removeStorage } from '../goldsrc/storage.js';
import { StreamedFiles, treeFiles, learnedPlan, PIECE } from '../goldsrc/files.js';
import { profileSnapshot, restoreProfile, setProfileIni, languageIni, envPreRun, toCloud } from './profile.js';
import { setIniDefaults } from './ini.js';
import { SeedWatch, toBase64, fromBase64, seedPathOk } from '../../host/profile-seed.js';

const STRINGS = {
  en: {
    subtitle: 'its original files, on a recompiled engine in your browser',
    failed: 'The game could not start: ', isolated: 'This page must be served with the browser isolation headers',
    noJspi: 'this browser cannot run the engine (WebAssembly JSPI): use a recent Chrome', noModule: 'the installed engine has no module to load',
    init: 'Starting the engine…', files: (pct) => `Loading the files · ${pct} %`, account: 'Checking your account\'s saves…',
    starting: 'Starting the game…', running: 'Game started. Click in the game to play.',
    steps: { engine: 'Starting the engine', files: 'Downloading the game files', game: 'Starting the game' },
    capture: 'Click the game to capture the mouse · Esc goes to the game (in full screen, twice releases the mouse) · ⛶ for full screen',
    released: 'Mouse released · click the game to capture it again',
    tips: [
      'The first launch downloads the game files into this browser: the next ones start from its own copy, much faster.',
      'Full screen (button above) gives the game the whole screen; hold Esc to leave it.',
      'In the game, a click captures the mouse; Esc releases it.',
      'Signed in to Orthros, your saves and settings follow you from one browser to another.',
      'The game runs entirely in your browser, from its original files: nothing is installed.',
    ],
    saveFailed: 'Saving in the browser failed. Keep this page open to retry.',
    restart: 'Restart the game', back: 'Back to the games', ended: 'The game has ended.',
    waiting: (mb) => `Loading the game's files · ${mb} MB`,
    lateTitle: 'A save on your account', lateText: (t) => `Your account already has a save of ${t}, different from this browser's. Restart with your account's save, or send this browser's one over it (the account's stays in its history)?`,
    lateAccount: 'Restart with the account\'s save', lateDevice: 'Keep this browser\'s save',
    modes: { story: 'Story', free: 'Free mode', solo: 'Play' },
    modeNotes: { story: 'The game from its beginning, its saves at the safe houses.', free: 'The game completed at 100 %: the whole city open, every property bought, everything unlocked. Save from the pause menu, anywhere.' },
    worldLost: 'Multiplayer: connection to the world lost, reconnecting…', worldBack: 'Multiplayer: connected to the world again',
    worldSignIn: 'Multiplayer needs an Orthros account: sign in from the games\' page, then come back',
  },
  fr: {
    subtitle: 'ses fichiers d’origine, sur un moteur recompilé dans ton navigateur',
    failed: 'Le jeu n’a pas pu démarrer : ', isolated: 'Cette page doit être servie avec les en-têtes d’isolation du navigateur',
    noJspi: 'ce navigateur ne peut pas faire tourner le moteur (WebAssembly JSPI) : utilise un Chrome récent', noModule: 'le moteur installé n’a pas de module à charger',
    init: 'Démarrage du moteur…', files: (pct) => `Chargement des fichiers · ${pct} %`, account: 'Vérification des sauvegardes de ton compte…',
    starting: 'Lancement du jeu…', running: 'Partie lancée. Clique dans le jeu pour jouer.',
    steps: { engine: 'Démarrage du moteur', files: 'Téléchargement des fichiers du jeu', game: 'Lancement du jeu' },
    capture: 'Clique dans le jeu pour capturer la souris · Échap va au jeu (en plein écran, deux fois libère la souris) · ⛶ pour le plein écran',
    released: 'Souris libérée · clique dans le jeu pour la capturer de nouveau',
    tips: [
      'Le premier lancement télécharge les fichiers du jeu dans ce navigateur : les suivants partent de sa copie, bien plus vite.',
      'Le plein écran (bouton en haut) donne tout l’écran au jeu ; maintiens Échap pour en sortir.',
      'En jeu, un clic capture la souris ; Échap la libère.',
      'Connecté à Orthros, tes sauvegardes et tes réglages te suivent d’un navigateur à l’autre.',
      'Le jeu tourne entièrement dans ton navigateur, depuis ses fichiers d’origine : rien n’est installé.',
    ],
    saveFailed: 'La sauvegarde navigateur a échoué. Garde cette page ouverte pour réessayer.',
    restart: 'Relancer le jeu', back: 'Revenir aux jeux', ended: 'Le jeu s’est terminé.',
    waiting: (mb) => `Chargement des fichiers du jeu · ${mb} Mo`,
    lateTitle: 'Une sauvegarde sur ton compte', lateText: (t) => `Ton compte a déjà une sauvegarde de ${t}, différente de celle de ce navigateur. Relancer avec celle du compte, ou envoyer celle de ce navigateur par-dessus (celle du compte reste dans son historique) ?`,
    lateAccount: 'Relancer avec celle du compte', lateDevice: 'Garder celle de ce navigateur',
    modes: { story: 'Histoire', free: 'Mode libre', solo: 'Jouer' },
    modeNotes: { story: 'Le jeu depuis son début, ses sauvegardes dans les planques.', free: 'Le jeu fini à 100 % : toute la ville ouverte, toutes les propriétés achetées, tout débloqué. Sauvegarde depuis le menu pause, n’importe où.' },
    worldLost: 'Multijoueur : connexion au monde perdue, reconnexion…', worldBack: 'Multijoueur : de nouveau connecté au monde',
    worldSignIn: 'Le multijoueur demande un compte Orthros : connecte-toi depuis la page des jeux, puis reviens',
  },
};
const lang = pickLang(), S = STRINGS[lang] ?? STRINGS.en;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
/** The game's folder in the engine's file system: its files mounted there, its working directory. */
const ROOT = '/game';
const logs = [], session = { state: 'loading', logs, engine: null, config: null };
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
let engine, FS = null, db, timer, cloudTimer, saving, stopped = false, profileReady = false, finalSave = null, reloadWhenSaved = false;
/** The nodes of the mounted game files: never part of the profile. */
let gameNodes = new Set();
function log(line) { logs.push(String(line)); if (logs.length > 500) logs.shift(); shell?.log(String(line)); }
/** The engine's normal ways out: Emscripten's exit (ExitStatus) and the unwinding of its main loop. */
const isExit = (e) => e === 'unwind' || e?.name === 'ExitStatus';
window.addEventListener('error', (event) => {
  if (isExit(event.error) || (stopped && event.error === Infinity)) { event.preventDefault(); return; }
  log(`Page error: ${event.message}`); report('error', { message: String(event.message).slice(0, 300), where: 'page' });
});
window.addEventListener('unhandledrejection', (event) => {
  if (isExit(event.reason)) { event.preventDefault(); return; } // (the engine's glue rethrows its exit: the game ended)
  log(`Unhandled: ${event.reason?.message ?? event.reason}`); report('error', { message: String(event.reason?.message ?? event.reason).slice(0, 300), where: 'promise' });
});

// ---------------------------------------------------------------- what the server learns of a session (/api/telemetry)
// (its start, its errors with the end of the engine's log, its end with its length and frame rate; a few a session)
const telemetry = { session: crypto.randomUUID().replaceAll('-', '').slice(0, 16), started: performance.now(), sent: 0 };
function report(event, data = {}) {
  if (telemetry.sent >= 20) return; telemetry.sent++;
  const body = JSON.stringify({ session: telemetry.session, game: decodeURIComponent(location.pathname.split('/').filter(Boolean)[2] ?? ''), port: 're3', event,
    seconds: Math.round((performance.now() - telemetry.started) / 1000), state: session.state, ...data,
    env: { ua: navigator.userAgent, cores: navigator.hardwareConcurrency, memGB: navigator.deviceMemory ?? null, dpr: devicePixelRatio, screen: `${screen.width}x${screen.height}` } });
  try { if (!navigator.sendBeacon('/api/telemetry', new Blob([body], { type: 'application/json' }))) throw new Error('beacon refused'); }
  catch { fetch('/api/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {}); }
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
  step('game', 'done');
  shell.hideLoader();
  shell.running = true; shell.watchPointer(document);
  status(S.running);
}
/** The loading screen again, with its message and buttons (the end of the game, an error): the mouse given back. */
function showEnd(text, error, buttons) {
  shell.running = false; shell.showLoader(); status(text, error);
  if (document.pointerLockElement) document.exitPointerLock();
  const acts = Object.assign(document.createElement('div'), { className: 'acts' });
  for (const { label, primary, onclick } of buttons) {
    const b = document.createElement('button'); b.type = 'button'; b.className = primary ? 'primary' : ''; b.textContent = label; b.onclick = onclick;
    acts.append(b);
  }
  shell.choices.replaceChildren(acts);
  acts.querySelector('button')?.focus();
}
const fail = (error) => {
  if (session.state === 'error') { log(error?.stack ?? error); return; } // (one report: an abort then its rejection)
  const crashed = profileReady; // (an engine that ran: its profile is kept; a new start reloads the page — a stopped engine cannot start again)
  session.state = 'error'; log(error?.stack ?? error); world?.link.close();
  report('crash', { message: String(error?.message ?? error).slice(0, 300), crashed, log: logs.slice(-30).map((l) => l.slice(0, 200)) });
  if (timer) clearInterval(timer); if (cloudTimer) clearInterval(cloudTimer);
  if (!shell) return;
  showEnd(S.failed + (error?.message ?? error), true, [{ label: S.restart, primary: true, onclick: restart }]);
  if (crashed) finalSave = saveAndPush();
};
/**
 * The game ended (the player quit it from its menu: main() returned, or the engine exited): the profile saved here and
 * on the account, then the loading screen with "the game has ended", to start it again or go back to the games.
 */
function ended(code) {
  if (session.state === 'ended' || session.state === 'error' || !shell) return;
  log(`The game ended (${code ?? 0})`);
  endReport();
  session.state = 'ended'; session.exitCode = code ?? 0; world?.link.close();
  if (timer) clearInterval(timer); if (cloudTimer) clearInterval(cloudTimer);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  showEnd(S.ended, false, [{ label: S.restart, primary: true, onclick: restart }, { label: S.back, onclick: () => shell.quit() }]);
  finalSave = saveAndPush();
}
/** Start again: the page reloaded (an engine that ran cannot start again in it) once the profile's last save is done. */
async function restart(event) {
  if (event?.currentTarget) event.currentTarget.disabled = true;
  await finalSave;
  location.reload();
}

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
// event) and tells the page (Module.orthrosMouse: true in the game, false in its menus — where it may draw its own
// cursor over a hidden one, so the canvas' CSS cursor tells nothing); for an engine that does not tell, its hidden
// cursor. A click captures it again only while the game wants it — after the browser released it (Esc) — never where the
// mouse must stay free.
let engineMouse = null;
const wantsMouse = () => session.state === 'running' && (engineMouse ?? $('canvas').style.cursor === 'none');
// (how to capture the mouse: told the first time the game wants it)
let captureTold = false;
function tellCapture() {
  if (captureTold || !wantsMouse() || document.pointerLockElement) return;
  captureTold = true; toast(S.capture, 7000);
}
new MutationObserver(tellCapture).observe($('canvas'), { attributes: true, attributeFilter: ['style'] });
/** The engine took the mouse (the game) or freed it (a menu). */
function onMouseMode(relative) { engineMouse = relative; tellCapture(); }
escapeToGame(window); // (the first Escape to the game, the next frees the mouse)
$('canvas').addEventListener('pointerdown', () => { if (wantsMouse() && document.pointerLockElement !== $('canvas')) $('canvas').requestPointerLock()?.catch?.(() => {}); });
$('canvas').addEventListener('contextmenu', (event) => event.preventDefault());
// (the engine may free the mouse a moment after the lock ends: only a release by the player is told)
document.addEventListener('pointerlockchange', () => setTimeout(() => { if (!document.pointerLockElement && wantsMouse() && !stopped) toast(S.released, 4000); }, 150));
/** The header's mouse indicator clicked: the game gets the mouse when it wants it, else the keys. */
function giveMouse() {
  $('canvas').focus();
  if (wantsMouse()) $('canvas').requestPointerLock()?.catch?.(() => {}); else toast(S.capture, 5000);
}

// ---------------------------------------------------------------- the header's frame rate
// (a frame is one the engine displayed: it calls Module.orthrosFrame after each)
const perf = { frames: [], samples: [], started: 0 };
function onFrame() {
  perf.frames.push(performance.now());
  if (perf.frames.length > 400) perf.frames.splice(0, perf.frames.length - 400);
  if (session.state === 'running' && ++perf.started === 10) hideLoader(); // (its first images: the game is shown)
}
setInterval(() => {
  const now = performance.now(), recent = perf.frames.filter((t) => t > now - 500);
  const gaps = recent.slice(1).map((t, i) => t - recent[i]).sort((a, b) => a - b);
  perf.samples.push({ fps: recent.length * 2, max: gaps.at(-1) ?? 0, p99: gaps[Math.floor(gaps.length * 0.99)] ?? 0 });
  if (perf.samples.length > 120) perf.samples.shift();
  shell?.setFps(perf.samples, session.state !== 'running' || perf.started < 10 ? 'loading' : document.hidden ? 'paused' : 'running');
  const seed = seedWatch?.step(now, perf.started); if (seed) reportSeed(seed);
  showWait(now);
}, 500);
// (the game waiting for its files — a load over a thin link, its image still meanwhile: told after 1.5 s, with the
// bytes come since, until its reads stop waiting)
let waitSince = null, waitBytes = 0;
function showWait(now) {
  const s = streamed?.stats, waiting = session.state === 'running' && streamed && (streamed.demand > 0 || now - streamed.demandEnd < 500);
  if (!waiting) { waitSince = null; return; }
  if (waitSince === null) { waitSince = now; waitBytes = s.fetchedBytes + s.localBytes; return; }
  if (now - waitSince > 1500) toast(S.waiting(((s.fetchedBytes + s.localBytes - waitBytes) / 1048576).toFixed(1)), 1500);
}
/** The session's end, once: its length and frame rate. */
function endReport() { if (telemetry.ended) return; telemetry.ended = true; report('end', { frames: frameStats(), audio: audioState() }); }
/** The last minute's frame rate and slowest frames, for the session's report. */
function frameStats() {
  const a = perf.samples.filter((x) => x.fps > 0); if (!a.length) return null;
  return { fps: Math.round(a.reduce((t, x) => t + x.fps, 0) / a.length), p99: Math.round(Math.max(...a.map((x) => x.p99))) };
}

// ---------------------------------------------------------------- the profile, here and on the account (cloud-sync.js)
const name = decodeURIComponent(location.pathname.split('/').filter(Boolean)[2] ?? '');
const sessionId = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
let config, files, streamed;
/**
 * The profile now: the engine's tree once it is in place, else — before, or once saves of it stopped (the page goes, or
 * the account's copy replaced it) — the one kept in this browser.
 */
// (the profile's snapshot taken again only once the engine changed a file — a walk of the whole game folder, 1,500 files,
// a hitch in a frame: FS writes, removals and renames mark it)
let profileDirty = true, profileCache = null;
function snapshot() {
  if (profileDirty || !profileCache) { profileCache = profileSnapshot(FS, ROOT, gameNodes); profileDirty = false; }
  return profileCache;
}
function watchProfileWrites() {
  for (const op of ['write', 'unlink', 'rename', 'rmdir', 'mkdir', 'truncate', 'ftruncate', 'symlink']) {
    const original = FS[op]; if (typeof original !== 'function') continue;
    FS[op] = function (...a) { profileDirty = true; return original.apply(this, a); };
  }
}
const currentProfile = async () => (profileReady && !stopped ? snapshot() : (await readStorage(db, 'profile', 'files')) ?? []);
function newCloud(username) {
  return new CloudSave({
    game: name, user: username,
    // (the account's copy put in place while the game runs: recorded as in step, the page reloaded to start on it)
    onStatus: (s) => { if (!world?.link.joined()) shell.setSave(s); if (reloadWhenSaved && s.state === 'saved') location.reload(); },
    read: async () => toCloud(await currentProfile()),
    // The account's files in place of the profile, the previous one kept aside in the same store: before the engine
    // starts; or once it has, a conflict settled from the header — the engine's files are not replaced under it: no
    // more saves of them, and the page reloads to start on the account's (the game over: they wait for its restart).
    write: async (list) => {
      const replacing = profileReady && !stopped;
      if (replacing) stopped = true;
      try {
        const old = replacing ? snapshot() : await readStorage(db, 'profile', 'files');
        if (old?.length) await writeStorage(db, 'profile', `aside-${new Date().toISOString()}`, old);
        await writeStorage(db, 'profile', 'files', list.map((f) => ({ path: f.path, data: f.data })));
      } catch (error) { if (replacing) stopped = false; throw error; }
      if (replacing && session.state === 'running') reloadWhenSaved = true;
    },
  });
}
/**
 * Signed in while the game runs: its profile sent to the account, unless the account has another one — then the
 * player chooses: restart with the account's, or this browser's sent over it.
 */
async function lateSignIn(user) {
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

let savedSnapshot = null;
async function save() {
  if (!db || !profileReady || saving || stopped) return saving; // (stopped: the page goes, or the account's copy replaces this one)
  const files = snapshot();
  if (files === savedSnapshot) return; // (nothing written since the last save)
  saving = writeStorage(db, 'profile', 'files', files);
  try { await saving; savedSnapshot = files; session.lastSaveAt = Date.now(); } finally { saving = null; }
}
session.save = save;
/** The profile saved as it is now — after a save in flight, whose snapshot may be older — then sent to the account. */
async function saveAndPush() {
  try {
    while (saving) await saving.catch(() => {});
    await save();
    const sent = cloud ? await cloud.push() : null;
    return !sent || !['error', 'toobig', 'conflict'].includes(sent.state);
  } catch (error) { log('Profile save failed: ' + (error?.message ?? error)); return false; }
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
  // (then the files the engine reads at random as it goes, whole — its streaming archive, its sound bank: no wait for
  // them in the game once here; their turn after the game's own reads, demandFirst)
  await streamed.completeWanted(2);
  session.background = { ms: Math.round(performance.now() - t), ...streamed.stats };
  log(`Background loading done: ${JSON.stringify(session.background)}`);
}

// ---------------------------------------------------------------- the shared first-launch profile (profile-seed.js)
// A game's first start may write caches before the player does anything (a sound cache built by reading the header of
// every audio file: a long first start on a slow link). With the manifest's `profileSeed`, an empty profile gets the
// small files first sessions of the version wrote identical (the server's quorum), in place before the engine starts;
// else this session reports its own, taken at the player's first input, once it has gone on playing (SeedWatch). The
// ini files the version's languages and defaults name are left out: the player's settings, the screen's size among them.
let seedWatch = null, seedLanguage = null;
/** The files a seed may hold now: the profile's but its ini files. */
const seedFiles = (iniNames) => profileSnapshot(FS, ROOT, gameNodes).filter((f) => !iniNames.has(f.path.toLowerCase()));
/** The server's set put in the empty profile (true), or a watch of this first session set (false). */
async function seedProfile(language, iniNames) {
  const url = `/api/profile-seed/${encodeURIComponent(name)}?lang=${encodeURIComponent(language ?? '')}`;
  let files = [];
  try {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 3000); // (never holds the start long)
    const r = await fetch(url, { signal: ac.signal }).finally(() => clearTimeout(timer));
    const j = r.ok ? await r.json() : null;
    files = (Array.isArray(j?.files) ? j.files : []).map((f) => ({ path: f?.path, data: fromBase64(f?.data) })).filter((f) => f.data && seedPathOk(f.path) && !iniNames.has(f.path.toLowerCase()));
  } catch { /* none: learned below */ }
  if (files.length) { restoreProfile(FS, ROOT, files, log); log(`Profile: ${files.length} file(s) first sessions wrote put in place (shared first-launch profile)`); return true; }
  seedLanguage = language ?? '';
  seedWatch = new SeedWatch({ files: () => seedFiles(iniNames) });
  return false;
}
function reportSeed(files) {
  fetch(`/api/profile-seed/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lang: seedLanguage, session: sessionId, files: files.map((f) => ({ path: f.path, data: toBase64(f.data) })) }) }).catch(() => {});
}
// (the player's first input: what the game wrote until then, before anything typed)
document.addEventListener('pointerdown', () => seedWatch?.input(performance.now(), perf.started, false), { capture: true });
document.addEventListener('keydown', (event) => seedWatch?.input(performance.now(), perf.started, event.key.length === 1), { capture: true });

// ---------------------------------------------------------------- the shared world (docs/mmo.md, section 6)
// A version with `mmo` has a world on the server (src/host/mmo.js, /api/mmo/<version>/ws). The engine owns its rules and
// every record; the page gives it, as Module.orthrosNet, the shared link (mmo-link.js: open, close, state, refusal,
// send, drain, away…) and what only the page knows: user() the Orthros account's name ('' when none); signIn() the
// account window over the game; `testing` (a boolean: ?mmotest in the page's address); `testCommands` (strings the
// engine takes one a frame) and debug(json) (the engine's state, every 500 ms under test). The link opens when the
// engine asks — its main menu's Multiplayer —, never before. A sign-in, a sign-out or another account on this page
// closes it: state() 0 again, and the engine — waiting on a sign-in, or in the world as the account that left — opens
// it again by itself, as the account now signed in (or is refused). window.orthrosMmo: { link, state (the engine's last
// debug object), updates, at, command(text) } — tools/re3/mmo-check.mjs drives two pages through it.
/** @type {{ link: ReturnType<typeof createMmoLink>, net: object } | null} */
let world = null, signInAsked = false;
function createWorld(versionId, username) {
  const url = new URL(`/api/mmo/${encodeURIComponent(versionId)}/ws`, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let last = LINK.CLOSED, lostInWorld = false, shownJoined = false;
  const link = createMmoLink({ url, log: (line) => log(`Shared world: ${line}`), onState: (state, l) => {
    session.world = { state, refusal: l.refusal(), joined: l.joined() };
    if (state !== last) {
      if (state === LINK.WAITING && last === LINK.OPEN && l.joined()) { lostInWorld = true; toast(S.worldLost, 6000); }
      else if (state === LINK.OPEN && lostInWorld) { lostInWorld = false; toast(S.worldBack, 3000); }
      else if (state === LINK.CLOSED || state === LINK.REFUSED) lostInWorld = false;
      last = state;
    }
    // (the header's saves: the world's server keeps the character while one is in the world)
    if (l.joined() !== shownJoined) { shownJoined = l.joined(); shell?.setSave(shownJoined ? { state: 'server' } : cloud?.status ?? null); }
  } });
  link.away(document.hidden);
  const probe = { link, state: null, updates: 0, at: 0, command: (text) => net.testCommands.push(String(text)) };
  const net = {
    ...link,
    user: () => shell?.account?.username ?? '',
    signIn: () => askSignIn(),
    testing: params.has('mmotest'),
    testCommands: [],
    debug: (json) => {
      try { probe.state = JSON.parse(json); } catch { probe.state = { error: 'not JSON', text: String(json).slice(0, 300) }; }
      probe.updates++; probe.at = performance.now();
    },
  };
  window.orthrosMmo = probe;
  let account = username;
  onAccountChange(({ user }) => {
    const now = user?.username ?? null;
    if (now === account) return;
    account = now;
    if (user && signInAsked) { signInAsked = false; window.orthrosData?.close?.(); $('canvas').focus(); } // (back to the game)
    if (link.state() !== LINK.CLOSED) link.close();
  });
  return { link, net };
}
/**
 * The engine asks for a sign-in (its multiplayer needs an Orthros account): the account window (data-manager.js) — a
 * modal dialog, over the game in full screen too (the top layer); the mouse freed; closed once signed in.
 */
function askSignIn() {
  if (shell?.account || !shell?.accounts) return; // (signed in already, or a server without accounts: the engine shows the refusal)
  signInAsked = true;
  if (document.pointerLockElement) document.exitPointerLock();
  if (window.orthrosData?.open) window.orthrosData.open('account');
  else toast(S.worldSignIn, 9000);
}

/** The game's language: the one chosen on the home screen (?gameLang=, else remembered), among the version's. */
function gameLanguage(man) {
  const options = man.languages ?? [];
  let wanted = params.get('gameLang'); if (!options.includes(wanted)) { try { wanted = localStorage.getItem('orthros.gameLanguage.' + (man.gameId ?? name)); } catch { wanted = null; } }
  return options.includes(wanted) ? wanted : options.includes(lang) ? lang : options.includes('en') ? 'en' : options[0] ?? null;
}

const fmtMB = (bytes) => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
/**
 * The game started: the account's saves first, then the engine, the files, the profile, the game's own start; `mode`:
 * one of the version's ways to play it (re3.modes: its arguments after re3.args), or none.
 */
async function start(mode = null) {
  session.state = 'starting'; session.mode = mode;
  if (!crossOriginIsolated) throw new Error(S.isolated);
  if (typeof WebAssembly.Suspending !== 'function') throw new Error(S.noJspi);
  const r = config.re3, base = `/engines/${encodeURIComponent(r.engine)}/`, language = gameLanguage(config), own = r.languages?.[language] ?? {};
  if (!r.module) throw new Error(S.noModule);
  step('engine', 'active'); step('files', ''); step('game', '');
  db = await openStorage(config.saveKey);
  const who = await shell.ready;
  if (who.user) {
    status(S.account);
    cloud = newCloud(who.user.username);
    const what = await cloud.pull().catch((e) => { log('Account saves: ' + e.message); return 'offline'; });
    if (what === 'conflict') await shell.resolveConflict(cloud);
  }
  world = config.mmo ? createWorld(name, who.user?.username ?? null) : null;
  status(S.init);
  // (the module's own files — its WebAssembly — beside it in the release)
  const moduleUrl = base + r.module.split('/').map(encodeURIComponent).join('/'), dir = moduleUrl.slice(0, moduleUrl.lastIndexOf('/') + 1);
  const t = performance.now();
  const { default: createEngine } = await import(moduleUrl);
  engine = session.engine = await createEngine({
    canvas: $('canvas'), print: log, printErr: log, locateFile: (file) => dir + file, noInitialRun: true,
    onAbort: (reason) => fail(new Error(String(reason))), onExit: (code) => ended(code), orthrosFrame: onFrame, orthrosMouse: onMouseMode,
    ...(world ? { orthrosNet: world.net } : {}), // (the shared world: the engine's way to it)
    preRun: [envPreRun(own.env, log)], // (the language's environment, before the runtime copies it)
  });
  step('engine', 'done', `${((performance.now() - t) / 1000).toFixed(1)} s`);
  FS = engine.FS;
  FS.mkdirTree(ROOT);
  // (the game's files: its whole tree now — the release's own over the version's, as the server lists it —, what
  // earlier sessions read first loaded before the start, the rest later; a stream's next bytes read ahead; a game file
  // the engine writes anew, a file of the profile in its place)
  // (asyncReads: a read waiting for bytes suspends the engine — JSPI — instead of holding the page over a synchronous
  // request; demandFirst: the background loads wait while it does, in requests of 1 MiB at most — a thin link's bytes
  // go to the game's reads first)
  streamed = session.files = new StreamedFiles({ name, files, log, readAhead: 16, rewritable: true, asyncReads: true, demandFirst: true, backgroundRange: 1 << 20, store: {
    read: (key) => readStorage(db, 'content', key), write: (key, bytes) => writeStorage(db, 'content', key, bytes), writeMany: (entries) => writeManyStorage(db, 'content', entries),
    keys: () => storageKeys(db, 'content'), remove: (keys) => removeStorage(db, 'content', keys) } });
  streamed.mount(FS, ROOT);
  gameNodes = new Set([...streamed.files.values()].map((f) => f.node));
  const t0 = performance.now();
  const [learned] = await Promise.all([fetch(`/api/prefetch/${encodeURIComponent(name)}`).then((res) => (res.ok ? res.json() : [])).catch(() => []), streamed.openLocal().catch((error) => log('Content cache unavailable: ' + error.message))]);
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
  step('files', 'done', fmtMB(total));
  // (the profile in the game's folder, over the game's files it replaced; the language's settings — re3.languages.<code>,
  // the player's choice of the version's languages —, in every ini file a language names: a game's own copied into the
  // profile even when it has these settings, for the engine to write in)
  const kept = (await readStorage(db, 'profile', 'files')) ?? [];
  if (config.profileSeed && params.get('profileseed') !== '0' && !kept.length) {
    await seedProfile(language, new Set([...languageIni(r.languages, language).map(([file]) => file), ...Object.keys(r.defaults ?? {})].map((file) => file.toLowerCase())));
  }
  restoreProfile(FS, ROOT, kept, log);
  profileReady = true; watchProfileWrites();
  for (const [file, sections] of languageIni(r.languages, language)) {
    try { log(`${file}: ${setProfileIni(FS, ROOT, file, sections, gameNodes)} (${language})`); } catch (error) { log(`${file}: not set (${error.message})`); }
  }
  // (the version's defaults — re3.defaults —, set once in a profile: the player's later choice stays)
  for (const [file, sections] of Object.entries(r.defaults ?? {})) {
    try { log(`${file}: ${setProfileIni(FS, ROOT, file, sections, gameNodes, setIniDefaults)} (defaults)`); } catch (error) { log(`${file}: defaults not set (${error.message})`); }
  }
  FS.chdir(ROOT);
  step('game', 'active', '', 0.3); status(S.starting);
  streamed.start(); // (the reads are learned from the engine's start)
  // (from now on the background loads leave the page its frames: 6 MB a second at most — on a fast link everything at
  // once held the page's thread a minute, the game at a frame every few seconds; the owner's link stays under it)
  streamed.backgroundRate = 6 << 20;
  session.state = 'running'; report('start', { engine: r.engine, mode, signedIn: !!shell.account });
  loadInBackground(plan.filter((e) => !e.startup)).catch((error) => log('Background loading failed: ' + error.message));
  setTimeout(() => reportReads(), 30000); setInterval(() => reportReads(), 120000);
  setTimeout(() => report('audio', audioState()), 60000); // (a minute in: is the game heard?)
  timer = setInterval(() => save().catch((error) => { log('Profile save failed: ' + error.message); status(S.saveFailed, true); }), 10000);
  // (the account's copy: a minute after a change at most — CloudSave sends only what changed)
  cloudTimer = setInterval(() => { if (cloud && session.state === 'running') cloud.push(); }, 60000);
  $('canvas').focus();
  // (main() runs until the player quits the game: its promise settles then — JSPI; an engine on a main loop returns at
  // once and ends through onExit)
  const run = engine.callMain([...(r.args ?? []), ...(r.modes?.[mode]?.args ?? [])]);
  if (typeof run?.then === 'function') run.then((code) => ended(code), (error) => (isExit(error) ? ended(error.status) : fail(error)));
}

/**
 * Back to the games: the profile kept here and on the account; false when it could not be sent. (The engine is not
 * asked to quit: the page goes.)
 */
async function quit() {
  if (session.state === 'ended' || session.state === 'error') return finalSave ?? true;
  if (session.state !== 'running') return true;
  return saveAndPush();
}

/**
 * The version's ways to play the game, on the loading screen: one button each (the last one chosen focused), its
 * note under them; the game starts on the one chosen (?mode= chooses at once).
 */
function chooseMode(modes) {
  session.state = 'choosing'; shell.showProgress(false);
  const key = 'orthros.re3Mode.' + name;
  let last = null; try { last = localStorage.getItem(key); } catch { /* none */ }
  const note = Object.assign(document.createElement('p'), { className: 'note' }), acts = Object.assign(document.createElement('div'), { className: 'acts' });
  const buttons = modes.map((m, i) => Object.assign(document.createElement('button'), {
    type: 'button', id: 'mode-' + m, className: (last ?? modes[0]) === m ? 'primary' : '', textContent: S.modes[m] ?? m,
    onfocus: () => { note.textContent = S.modeNotes[m] ?? ''; }, onmouseenter: () => { note.textContent = S.modeNotes[m] ?? ''; },
    onclick: () => {
      try { localStorage.setItem(key, m); } catch { /* not kept */ }
      shell.choices.replaceChildren(); shell.showProgress(true);
      start(m).catch((error) => fail(error));
    },
  }));
  acts.append(...buttons);
  shell.choices.replaceChildren(acts, note);
  (buttons[modes.indexOf(last)] ?? buttons[0]).focus();
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
  if (config.runtime !== 're3') throw new Error('not an re3 installation');
  files = treeFiles(await treeResponse.json());
  shell = createShell({
    title: config.name, version: config.version, gameLanguage: gameLanguage(config), cover: `/api/cover/${encodeURIComponent(name)}`, subtitle: S.subtitle,
    steps: Object.entries(S.steps).map(([k, label]) => ({ k, label })), tips: S.tips,
    onQuit: quit, onFullscreen: fullscreen, onMouse: giveMouse, onSignedIn: lateSignIn, saves: () => cloud,
    onLoaderHidden: fit,
  });
  shell.sound.addEventListener('click', resumeAudio);
  const modes = Object.keys(config.re3.modes ?? {});
  if (modes.length > 1 && !modes.includes(params.get('mode'))) chooseMode(modes);
  else await start(modes.length ? (modes.includes(params.get('mode')) ? params.get('mode') : modes[0]) : null);
} catch (error) { if (shell) fail(error); else document.body.textContent = S.failed + (error.message ?? error); }

document.addEventListener('visibilitychange', () => {
  world?.link.away(document.hidden); // (the engine stops with the page's frames: the others are told, its entities go to them)
  if (document.hidden && session.state === 'running') save().then(() => cloud?.push()).catch(log);
});
window.addEventListener('pagehide', () => {
  world?.link.close();
  if (session.state === 'running') endReport();
  stopped = true; if (timer) clearInterval(timer); if (cloudTimer) clearInterval(cloudTimer); reportReads(true);
});
