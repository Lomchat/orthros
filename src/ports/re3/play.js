// The page of an re3 browser port (src/host/re3.js, docs/browser-ports.md "re3 ports"), /ports/re3/<manifest>/: the
// pinned engine release the manifest names (/engines/<release>/: an Emscripten ES module — SDL2 on WebGL 2, OpenAL on
// WebAudio, JSPI), the version's game files streamed into the game's folder with the release's own over them
// (../goldsrc/files.js: what the game reads first loaded before it starts, the rest as it goes; kept in IndexedDB), and
// the files the engine writes there — saves, settings, its ini file — as the player's profile (profile.js), in
// IndexedDB under the installation's key and on the player's Orthros account (cloud-sync.js). Single player only.
// Around the game, the frame every Orthros game has (/src/host/web/shell.js): the header (the mouse, the saves, the
// frame rate, full screen, back to the games), the loading screen, the game filling the rest of the window. It never
// loads the Win32 runtime, and nothing here names a game.
import { pickLang } from '../../host/web/lang.js';
import { createShell } from '../../host/web/shell.js';
import { CloudSave } from '../../host/web/cloud-sync.js';
import { openStorage, readStorage, writeStorage, storageKeys, removeStorage } from '../goldsrc/storage.js';
import { StreamedFiles, treeFiles, learnedPlan, PIECE } from '../goldsrc/files.js';
import { profileSnapshot, restoreProfile, setProfileIni, toCloud } from './profile.js';

const STRINGS = {
  en: {
    subtitle: 'its original files, on a recompiled engine in your browser',
    failed: 'The game could not start: ', isolated: 'This page must be served with the browser isolation headers',
    noJspi: 'this browser cannot run the engine (WebAssembly JSPI): use a recent Chrome', noModule: 'the installed engine has no module to load',
    init: 'Starting the engine…', files: (pct) => `Loading the files · ${pct} %`, account: 'Checking your account\'s saves…',
    starting: 'Starting the game…', running: 'Game started. Click in the game to play.',
    steps: { engine: 'Starting the engine', files: 'Downloading the game files', game: 'Starting the game' },
    capture: 'Click the game to capture the mouse · Esc releases it · ⛶ for full screen',
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
    lateTitle: 'A save on your account', lateText: (t) => `Your account already has a save of ${t}, different from this browser's. Restart with your account's save, or send this browser's one over it (the account's stays in its history)?`,
    lateAccount: 'Restart with the account\'s save', lateDevice: 'Keep this browser\'s save',
  },
  fr: {
    subtitle: 'ses fichiers d’origine, sur un moteur recompilé dans ton navigateur',
    failed: 'Le jeu n’a pas pu démarrer : ', isolated: 'Cette page doit être servie avec les en-têtes d’isolation du navigateur',
    noJspi: 'ce navigateur ne peut pas faire tourner le moteur (WebAssembly JSPI) : utilise un Chrome récent', noModule: 'le moteur installé n’a pas de module à charger',
    init: 'Démarrage du moteur…', files: (pct) => `Chargement des fichiers · ${pct} %`, account: 'Vérification des sauvegardes de ton compte…',
    starting: 'Lancement du jeu…', running: 'Partie lancée. Clique dans le jeu pour jouer.',
    steps: { engine: 'Démarrage du moteur', files: 'Téléchargement des fichiers du jeu', game: 'Lancement du jeu' },
    capture: 'Clique dans le jeu pour capturer la souris · Échap la libère · ⛶ pour le plein écran',
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
    lateTitle: 'Une sauvegarde sur ton compte', lateText: (t) => `Ton compte a déjà une sauvegarde de ${t}, différente de celle de ce navigateur. Relancer avec celle du compte, ou envoyer celle de ce navigateur par-dessus (celle du compte reste dans son historique) ?`,
    lateAccount: 'Relancer avec celle du compte', lateDevice: 'Garder celle de ce navigateur',
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
let engine, FS = null, db, timer, cloudTimer, saving, stopped = false, profileReady = false, finalSave = null;
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
  session.state = 'error'; log(error?.stack ?? error);
  report('crash', { message: String(error?.message ?? error).slice(0, 300), crashed, log: logs.slice(-30).map((l) => l.slice(0, 200)) });
  if (timer) clearInterval(timer); if (cloudTimer) clearInterval(cloudTimer);
  if (!shell) return;
  showEnd(S.failed + (error?.message ?? error), true, [{ label: S.restart, primary: true, onclick: () => location.reload() }]);
  if (crashed) save().then(() => cloud?.push()).catch((e) => log('Profile save failed: ' + e.message));
};
/**
 * The game ended (the player quit it from its menu: main() returned, or the engine exited): the profile saved here and
 * on the account, then the loading screen with "the game has ended", to start it again or go back to the games.
 */
function ended(code) {
  if (session.state === 'ended' || session.state === 'error' || !shell) return;
  log(`The game ended (${code ?? 0})`);
  endReport();
  session.state = 'ended'; session.exitCode = code ?? 0;
  if (timer) clearInterval(timer); if (cloudTimer) clearInterval(cloudTimer);
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  showEnd(S.ended, false, [{ label: S.restart, primary: true, onclick: () => location.reload() }, { label: S.back, onclick: () => shell.quit() }]);
  finalSave = (async () => {
    try { await save(); const sent = cloud ? await cloud.push() : null; return !sent || !['error', 'toobig', 'conflict'].includes(sent.state); }
    catch (error) { log('Profile save failed: ' + (error?.message ?? error)); return false; }
  })();
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
// event), its cursor hidden then (the canvas' CSS cursor), shown where the mouse is free. A click captures it again only
// while the game wants it — after the browser released it (Esc) — never where the mouse must stay free.
const wantsMouse = () => session.state === 'running' && $('canvas').style.cursor === 'none';
// (how to capture the mouse: told the first time the game wants it)
let captureTold = false;
new MutationObserver(() => {
  if (captureTold || !wantsMouse() || document.pointerLockElement) return;
  captureTold = true; toast(S.capture, 7000);
}).observe($('canvas'), { attributes: true, attributeFilter: ['style'] });
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
}, 500);
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
/** The profile now: the engine's tree once it is in place, else the one kept in this browser. */
const currentProfile = async () => (profileReady ? profileSnapshot(FS, ROOT, gameNodes) : (await readStorage(db, 'profile', 'files')) ?? []);
function newCloud(username) {
  return new CloudSave({
    game: name, user: username, onStatus: (s) => shell.setSave(s),
    read: async () => toCloud(await currentProfile()),
    // (before the engine starts only: the previous profile kept aside in the same store)
    write: async (list) => {
      const old = await readStorage(db, 'profile', 'files');
      if (old?.length) await writeStorage(db, 'profile', `aside-${new Date().toISOString()}`, old);
      await writeStorage(db, 'profile', 'files', list.map((f) => ({ path: f.path, data: f.data })));
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

async function save() {
  if (!db || !profileReady || saving || stopped) return saving; // (stopped: the page goes, or the account's copy replaces this one)
  saving = writeStorage(db, 'profile', 'files', profileSnapshot(FS, ROOT, gameNodes));
  try { await saving; session.lastSaveAt = Date.now(); } finally { saving = null; }
}
session.save = save;

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

/** The game's language: the one chosen on the home screen (?gameLang=, else remembered), among the version's. */
function gameLanguage(man) {
  const options = man.languages ?? [];
  let wanted = params.get('gameLang'); if (!options.includes(wanted)) { try { wanted = localStorage.getItem('orthros.gameLanguage.' + (man.gameId ?? name)); } catch { wanted = null; } }
  return options.includes(wanted) ? wanted : options.includes(lang) ? lang : options.includes('en') ? 'en' : options[0] ?? null;
}

const fmtMB = (bytes) => `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
/** The game started at once: the account's saves first, then the engine, the files, the profile, the game's own start. */
async function start() {
  session.state = 'starting';
  if (!crossOriginIsolated) throw new Error(S.isolated);
  if (typeof WebAssembly.Suspending !== 'function') throw new Error(S.noJspi);
  const r = config.re3, base = `/engines/${encodeURIComponent(r.engine)}/`, language = gameLanguage(config);
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
  status(S.init);
  // (the module's own files — its WebAssembly — beside it in the release)
  const moduleUrl = base + r.module.split('/').map(encodeURIComponent).join('/'), dir = moduleUrl.slice(0, moduleUrl.lastIndexOf('/') + 1);
  const t = performance.now();
  const { default: createEngine } = await import(moduleUrl);
  engine = session.engine = await createEngine({
    canvas: $('canvas'), print: log, printErr: log, locateFile: (file) => dir + file, noInitialRun: true,
    onAbort: (reason) => fail(new Error(String(reason))), onExit: (code) => ended(code), orthrosFrame: onFrame,
  });
  step('engine', 'done', `${((performance.now() - t) / 1000).toFixed(1)} s`);
  FS = engine.FS;
  FS.mkdirTree(ROOT);
  // (the game's files: its whole tree now — the release's own over the version's, as the server lists it —, what
  // earlier sessions read first loaded before the start, the rest later; a stream's next bytes read ahead)
  streamed = session.files = new StreamedFiles({ name, files, log, readAhead: 16, store: {
    read: (key) => readStorage(db, 'content', key), write: (key, bytes) => writeStorage(db, 'content', key, bytes),
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
  // (the profile in the game's folder, over the game's files it replaced; the language's settings and environment —
  // re3.languages.<code>, the player's choice of the version's languages)
  restoreProfile(FS, ROOT, await readStorage(db, 'profile', 'files'), log);
  profileReady = true;
  const own = r.languages?.[language] ?? {};
  for (const [file, sections] of Object.entries(own.ini ?? {})) {
    try { log(`${file}: ${setProfileIni(FS, ROOT, file, sections, gameNodes)} (${language})`); } catch (error) { log(`${file}: not set (${error.message})`); }
  }
  for (const [key, value] of Object.entries(own.env ?? {})) { if (engine.ENV) engine.ENV[key] = value; else log(`${key}: the engine exposes no environment`); }
  FS.chdir(ROOT);
  step('game', 'active', '', 0.3); status(S.starting);
  streamed.start(); // (the reads are learned from the engine's start)
  session.state = 'running'; report('start', { engine: r.engine, signedIn: !!shell.account });
  loadInBackground(plan.filter((e) => !e.startup)).catch((error) => log('Background loading failed: ' + error.message));
  setTimeout(() => reportReads(), 30000); setInterval(() => reportReads(), 120000);
  setTimeout(() => report('audio', audioState()), 60000); // (a minute in: is the game heard?)
  timer = setInterval(() => save().catch((error) => { log('Profile save failed: ' + error.message); status(S.saveFailed, true); }), 10000);
  // (the account's copy: a minute after a change at most — CloudSave sends only what changed)
  cloudTimer = setInterval(() => { if (cloud && session.state === 'running') cloud.push(); }, 60000);
  $('canvas').focus();
  // (main() runs until the player quits the game: its promise settles then — JSPI; an engine on a main loop returns at
  // once and ends through onExit)
  const run = engine.callMain([...(r.args ?? [])]);
  if (typeof run?.then === 'function') run.then((code) => ended(code), (error) => (isExit(error) ? ended(error.status) : fail(error)));
}

/**
 * Back to the games: the profile kept here and on the account; false when it could not be sent. (The engine is not
 * asked to quit: the page goes.)
 */
async function quit() {
  if (session.state === 'ended') return finalSave ?? true;
  if (session.state !== 'running') return true;
  try {
    await save();
    const sent = cloud ? await cloud.push() : null;
    return !sent || !['error', 'toobig', 'conflict'].includes(sent.state);
  } catch (error) { log('Quit: ' + (error?.message ?? error)); return false; }
}

async function fullscreen() {
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch (error) { status(error.message, true); return; }
  try { await navigator.keyboard?.lock?.(['Escape']); } catch { /* keyboard lock unavailable: Esc leaves the full screen */ }
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
  await start();
} catch (error) { if (shell) fail(error); else document.body.textContent = S.failed + (error.message ?? error); }

document.addEventListener('visibilitychange', () => { if (document.hidden && session.state === 'running') save().then(() => cloud?.push()).catch(log); });
window.addEventListener('pagehide', () => {
  if (session.state === 'running') endReport();
  stopped = true; if (timer) clearInterval(timer); if (cloudTimer) clearInterval(cloudTimer); reportReads(true);
});
