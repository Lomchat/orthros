// The page of a GoldSrc browser port (src/host/goldsrc.js, docs/browser-ports.md), /ports/goldsrc/<manifest>/: the
// pinned engine release the manifest names (/engines/<release>/), the version's game files streamed (files.js: what
// the game reads first loaded before it starts, the rest as it goes; kept in IndexedDB), the writable profile (saves,
// settings) in IndexedDB under the installation's key, multiplayer through the server's relay (/api/udp/<manifest>).
// It never loads the Win32 runtime, and nothing here names a game.
import { pickLang } from '../../host/web/lang.js';
import { openStorage, readStorage, writeStorage, storageKeys, removeStorage, writableSnapshot, restoreSnapshot } from './storage.js';
import { StreamedFiles, treeFiles, learnedPlan, PIECE } from './files.js';

const STRINGS = {
  en: {
    back: '← All games', name: 'Nickname', mode: 'Mode', play: 'Play', fullscreen: 'Full screen', stop: 'Quit and save', log: 'Launch log',
    help: 'Keyboard and mouse · Click in the game to capture the mouse · Esc releases it.',
    loading: 'Loading the game…', preparing: 'Preparing the installation.', solo: 'Single player', multiplayer: 'Multiplayer',
    ready: 'Ready. Choose a mode and start the game.', noServer: 'The multiplayer server is not available yet.',
    failed: 'The game could not start: ', isolated: 'This page must be served with the browser isolation headers',
    init: 'Starting the engine…', files: (pct) => `Loading the files · ${pct} %`, running: 'Game started. Click in the game to play.',
    saveFailed: 'Saving in the browser failed. Keep this page open to retry.', stopped: 'Game over. Saves and settings are kept.',
    cannotSave: 'Cannot save: ', lost: 'Connection to the server lost. Quit the game and start it again.',
    unreachable: 'Multiplayer server unreachable', refused: 'Multiplayer connection refused',
    engineFiles: 'Engine resources unavailable',
  },
  fr: {
    back: '← Tous les jeux', name: 'Pseudo', mode: 'Mode', play: 'Jouer', fullscreen: 'Plein écran', stop: 'Quitter et enregistrer', log: 'Journal de lancement',
    help: 'Clavier et souris · Clique dans le jeu pour capturer la souris · Échap pour la libérer.',
    loading: 'Chargement du jeu…', preparing: 'Préparation de l’installation.', solo: 'Campagne solo', multiplayer: 'Multijoueur',
    ready: 'Prêt. Choisis un mode et lance la partie.', noServer: 'Le serveur multijoueur n’est pas encore disponible.',
    failed: 'Le jeu n’a pas pu démarrer : ', isolated: 'Cette page doit être servie avec les en-têtes d’isolation du navigateur',
    init: 'Initialisation du moteur…', files: (pct) => `Chargement des fichiers · ${pct} %`, running: 'Partie lancée. Clique dans le jeu pour jouer.',
    saveFailed: 'La sauvegarde navigateur a échoué. Garde cette page ouverte pour réessayer.', stopped: 'Partie terminée. Les sauvegardes et réglages sont conservés.',
    cannotSave: 'Enregistrement impossible : ', lost: 'Connexion au serveur interrompue. Quitte la partie puis relance-la.',
    unreachable: 'Serveur multijoueur inaccessible', refused: 'Connexion multijoueur impossible',
    engineFiles: 'Ressources du moteur indisponibles',
  },
};
const lang = pickLang(), S = STRINGS[lang] ?? STRINGS.en;
document.documentElement.lang = lang;
const $ = id => document.getElementById(id);
for (const [id, key] of [['back', 'back'], ['nameLabel', 'name'], ['modeLabel', 'mode'], ['launch', 'play'], ['fullscreen', 'fullscreen'], ['stop', 'stop'], ['help', 'help'], ['logLabel', 'log'], ['title', 'loading'], ['status', 'preparing']]) $(id).textContent = S[key];
const status = text => { $('status').textContent = text; };
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
let engine, db, socket, timer, saving, stopped = false;
window.addEventListener('error', event => {
  if (stopped && (event.error === Infinity || event.error === 'unwind')) event.preventDefault();
});
const log = line => { logs.push(String(line)); if (logs.length > 500) logs.shift(); $('log').textContent = logs.slice(-100).join('\n'); };
const fail = error => { session.state = 'error'; status(S.failed + (error.message ?? error)); log(error.stack ?? error); $('launch').disabled = false; socket?.close(); if (timer) clearInterval(timer); };
const name = decodeURIComponent(location.pathname.split('/').filter(Boolean)[2] ?? '');
const sessionId = crypto.randomUUID().replaceAll('-', '').slice(0, 24);
let config, files, streamed;
try {
  const [manifestResponse, treeResponse] = await Promise.all([fetch(`/api/manifest/${encodeURIComponent(name)}`), fetch(`/api/tree/${encodeURIComponent(name)}`)]);
  if (!manifestResponse.ok || !treeResponse.ok) throw new Error(`HTTP ${manifestResponse.ok ? treeResponse.status : manifestResponse.status}`);
  config = session.config = await manifestResponse.json();
  if (config.runtime !== 'goldsrc') throw new Error('not a GoldSrc installation');
  files = treeFiles(await treeResponse.json());
  $('title').textContent = config.name; document.title = config.name + ' · Orthros';
  const g = config.goldsrc;
  for (const mode of ['solo', 'multiplayer']) {
    if (!g[mode]) continue;
    const option = document.createElement('option'); option.value = mode; option.textContent = S[mode]; $('mode').append(option);
  }
  const available = [...$('mode').options].find(option => !option.disabled);
  if (available) { $('mode').value = available.value; $('launch').disabled = false; }
  status(available ? S.ready : S.noServer); session.state = 'ready';
} catch (error) { fail(error); }

async function save() {
  if (!db || !engine?.em || saving) return saving;
  saving = writeStorage(db, 'profile', 'files', writableSnapshot(engine.em.FS));
  try { await saving; session.lastSaveAt = Date.now(); } finally { saving = null; }
}
session.save = save;

async function connect(Net) {
  const endpoint = new URL(`/api/udp/${encodeURIComponent(name)}`, location.href); endpoint.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(endpoint); socket.binaryType = 'arraybuffer';
  class BrowserNet extends Net {
    recvfrom(...args) {
      const result = super.recvfrom(...args);
      // The published wrapper uses 73; this Emscripten libc uses EAGAIN=6.
      // Empty nonblocking receives must not become persistent engine errors.
      if (result < 0 && this.em) this.em.setValue(this.em.Module.ccall('getErrnoLocation', 'number', [], []), 6, 'i32');
      return result;
    }
  }
  engine.net = new BrowserNet({ sendto(packet) {
    if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 1024 * 1024) socket.send(packet.data);
  } });
  socket.onmessage = event => { engine.net.incoming.enqueue({ data: new Uint8Array(event.data), ip: [127, 0, 0, 1], port: 8080 }); };
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error(S.unreachable)); }, 10000);
    socket.onopen = () => { clearTimeout(timeout); session.multiplayer = 'connected'; resolve(); };
    socket.onerror = () => { clearTimeout(timeout); reject(new Error(S.refused)); };
  });
  socket.onclose = () => { session.multiplayer = 'disconnected'; if (!stopped) status(S.lost); };
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

$('start').addEventListener('submit', async event => {
  event.preventDefault(); if (!config || session.state === 'starting' || session.state === 'running') return;
  $('launch').disabled = true; $('mode').disabled = true; session.state = 'starting'; $('progress').classList.remove('hidden');
  try {
    if (!crossOriginIsolated) throw new Error(S.isolated);
    const g = config.goldsrc, base = `/engines/${encodeURIComponent(g.engine)}/`;
    db = await openStorage(config.saveKey);
    const { Xash3D, Net, DEFAULT_SERVER_LIBRARY } = await import(base + 'engine/index.js');
    engine = session.engine = new Xash3D({
      canvas: $('canvas'),
      // (-dll: the engine opens the server module under the name the wrapper preloaded it with, not the one the game's
      // liblist.gam names — another name finds no library and the local server never starts;
      // ?debug: the engine's developer messages from its start)
      arguments: ['-windowed', '-noip6', '-game', g.gameDir, '-dll', DEFAULT_SERVER_LIBRARY, '-rodir', '/rodir', '-basedir', '/rwdir', '-width', '1024', '-height', '768', ...(new URLSearchParams(location.search).has('debug') ? ['-dev', '2'] : [])],
      libraries: {
        xash: base + 'engine/xash.wasm', filesystem: base + 'engine/filesystem_stdio.wasm',
        menu: base + (g.modules.menu ?? 'engine/libmenu.wasm'), client: base + g.modules.client, server: base + g.modules.server,
        render: { gl4es: base + 'engine/libref_webgl2.wasm' }
      },
      module: { print: log, printErr: log, onAbort: reason => fail(new Error(String(reason))) }
    });
    if ($('mode').value === 'multiplayer') await connect(Net);
    status(S.init); await engine.init();
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
    await StreamedFiles.pool(first.map((e) => async () => {
      await streamed.load(e.file, e.pieces); loaded += bytesOf(e);
      $('progress').value = loaded / Math.max(1, total); status(S.files(Math.round(loaded / Math.max(1, total) * 100)));
    }), 6);
    session.startup = { files: first.length, bytes: total, ms: Math.round(performance.now() - t0), ...streamed.stats };
    log(`Startup files: ${JSON.stringify(session.startup)}`);
    // (the release's archives the engine mounts from the game folder: its own extras by default, goldsrc.extras)
    for (const extra of g.extras ?? ['engine/valve/extras.pk3']) {
      const extrasResponse = await fetch(base + extra);
      if (!extrasResponse.ok) throw new Error(S.engineFiles);
      FS.writeFile(`/rodir/${g.gameDir}/${extra.split('/').pop()}`, new Uint8Array(await extrasResponse.arrayBuffer()));
    }
    FS.chdir('/rwdir');
    // (main() only schedules the engine's start: it runs once the engine's WebAssembly libraries are loaded, which
    // can be after this — no console command before it has run; the reads are learned from its start)
    const M = engine.em.Module, started = new Promise((resolve) => {
      const initialized = M.onRuntimeInitialized; M.onRuntimeInitialized = () => { streamed.start(); initialized?.(); };
      M.postRun = [...(Array.isArray(M.postRun) ? M.postRun : M.postRun ? [M.postRun] : []), resolve];
    });
    engine.main();
    await started;
    loadInBackground(plan.filter((e) => !e.startup)).catch((error) => log('Background loading failed: ' + error.message));
    setTimeout(() => reportReads(), 30000); setInterval(() => reportReads(), 120000);
    engine.Cmd_ExecuteString('developer ' + (new URLSearchParams(location.search).has('debug') ? '1' : '0'));
    const nickname = $('name').value.replace(/[^a-zA-Z0-9 _.-]/g, '').slice(0, 24) || 'Player';
    engine.Cmd_ExecuteString(`name "${nickname}"`); engine.Cmd_ExecuteString('setinfo "_vgui_menus" "0"');
    if ($('mode').value === 'multiplayer') engine.Cmd_ExecuteString('connect 127.0.0.1:8080');
    else { for (const command of g.solo.commands ?? []) engine.Cmd_ExecuteString(command); engine.Cmd_ExecuteString(`map ${g.solo.map}`); }
    session.command = command => engine.Cmd_ExecuteString(command);
    session.state = 'running'; status(S.running);
    $('start').classList.add('hidden'); $('progress').classList.add('hidden'); $('stop').disabled = false;
    timer = setInterval(() => save().catch(error => { log('Profile save failed: ' + error.message); status(S.saveFailed); }), 10000);
    $('canvas').focus();
  } catch (error) { fail(error); }
});

$('canvas').addEventListener('click', () => { if (session.state === 'running') $('canvas').requestPointerLock()?.catch?.(log); });
$('fullscreen').addEventListener('click', () => $('canvas').requestFullscreen().catch(error => status(error.message)));
$('stop').addEventListener('click', async () => {
  $('stop').disabled = true; stopped = true; if (timer) clearInterval(timer);
  try {
    engine?.Cmd_ExecuteString('host_writeconfig'); await save();
    try { engine?.quit(); } catch (error) {
      // Emscripten ends its main loop by unwinding; this is successful shutdown.
      if (error !== Infinity && error !== 'unwind' && error?.name !== 'ExitStatus') throw error;
    }
    await save(); socket?.close(); db?.close();
    session.state = 'stopped'; status(S.stopped); location.href = '/?menu';
  } catch (error) { stopped = false; $('stop').disabled = false; status(S.cannotSave + (error?.message ?? String(error))); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) save().catch(log); });
window.addEventListener('pagehide', () => { stopped = true; if (timer) clearInterval(timer); socket?.close(); reportReads(true); });
