// The page of a GoldSrc browser port (src/host/goldsrc.js, docs/browser-ports.md), /ports/goldsrc/<manifest>/: the
// pinned engine release the manifest names (/engines/<release>/), the version's game files (/game/<manifest>/, kept in
// IndexedDB once read), the writable profile (saves, settings) in IndexedDB under the installation's key, multiplayer
// through the server's relay (/api/udp/<manifest>). It never loads the Win32 runtime, and nothing here names a game.
import { pickLang } from '../../host/web/lang.js';
import { openStorage, readStorage, writeStorage, pruneStorage, writableSnapshot, restoreSnapshot } from './storage.js';

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
    missing: (f) => `File unavailable: ${f}`, short: (f) => `Incomplete file: ${f}`, engineFiles: 'Engine resources unavailable',
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
    missing: (f) => `Fichier indisponible : ${f}`, short: (f) => `Fichier incomplet : ${f}`, engineFiles: 'Ressources du moteur indisponibles',
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
/** Native binaries of the installation: useless to the WebAssembly engine, never downloaded. */
const NATIVE = /\.(exe|dll|so|dylib)$/i;
const name = decodeURIComponent(location.pathname.split('/').filter(Boolean)[2] ?? '');
const fileUrl = (path, route = 'game') => `/${route}/${encodeURIComponent(name)}/` + path.split('/').map(encodeURIComponent).join('/');
let config, files;
try {
  const [manifestResponse, treeResponse] = await Promise.all([fetch(`/api/manifest/${encodeURIComponent(name)}`), fetch(`/api/tree/${encodeURIComponent(name)}`)]);
  if (!manifestResponse.ok || !treeResponse.ok) throw new Error(`HTTP ${manifestResponse.ok ? treeResponse.status : manifestResponse.status}`);
  config = session.config = await manifestResponse.json();
  if (config.runtime !== 'goldsrc') throw new Error('not a GoldSrc installation');
  files = [];
  (function walk(node, prefix) {
    for (const [dir, sub] of Object.entries(node.dirs)) if (!dir.startsWith('.')) walk(sub, prefix + dir + '/');
    for (const [file, st] of Object.entries(node.files)) if (!file.startsWith('.') && !NATIVE.test(file)) files.push({ path: prefix + file, size: st.size, mtime: st.mtime });
  })(await treeResponse.json(), '');
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

/** A game file: from the browser's cache, else from the server (compressed when that saves bytes), then cached. */
async function gameFile(file, cache) {
  const key = `${file.path}\n${file.size}\n${file.mtime}`;
  let bytes = cache.enabled ? await readStorage(db, 'content', key) : null;
  if (!bytes) {
    if (file.size === 0) bytes = new Uint8Array(0);
    else {
      const response = await fetch(file.size <= 64 * 1024 * 1024 ? fileUrl(file.path, 'gamez') + `?r=0-${file.size}&p=1` : fileUrl(file.path));
      if (!response.ok) throw new Error(S.missing(file.path));
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    if (bytes.length !== file.size) throw new Error(S.short(file.path));
    if (cache.enabled) try { await writeStorage(db, 'content', key, bytes); } catch (error) { cache.enabled = false; log('Content cache unavailable: ' + error.message); }
  }
  cache.keys.add(key);
  return bytes;
}

$('start').addEventListener('submit', async event => {
  event.preventDefault(); if (!config || session.state === 'starting' || session.state === 'running') return;
  $('launch').disabled = true; $('mode').disabled = true; session.state = 'starting'; $('progress').classList.remove('hidden');
  try {
    if (!crossOriginIsolated) throw new Error(S.isolated);
    const g = config.goldsrc, base = `/engines/${encodeURIComponent(g.engine)}/`;
    db = await openStorage(config.saveKey);
    const { Xash3D, Net } = await import(base + 'engine/index.js');
    engine = session.engine = new Xash3D({
      canvas: $('canvas'),
      arguments: ['-windowed', '-noip6', '-game', g.gameDir, '-rodir', '/rodir', '-basedir', '/rwdir', '-width', '1024', '-height', '768'],
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
    FS.mkdirTree('/rodir'); FS.mkdirTree('/rwdir/' + g.gameDir);
    restoreSnapshot(FS, await readStorage(db, 'profile', 'files'));
    const total = files.reduce((sum, f) => sum + f.size, 0), cache = { enabled: true, keys: new Set() };
    let loaded = 0, next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < files.length) {
        const file = files[next++], bytes = await gameFile(file, cache);
        const target = '/rodir/' + file.path; FS.mkdirTree(target.slice(0, target.lastIndexOf('/'))); FS.writeFile(target, bytes);
        loaded += file.size; $('progress').value = loaded / Math.max(1, total);
        status(S.files(Math.round(loaded / Math.max(1, total) * 100)));
      }
    }));
    if (cache.enabled) pruneStorage(db, 'content', cache.keys).catch(error => log('Content cache cleanup failed: ' + error.message));
    const extrasResponse = await fetch(base + 'engine/valve/extras.pk3');
    if (!extrasResponse.ok) throw new Error(S.engineFiles);
    FS.writeFile(`/rodir/${g.gameDir}/extras.pk3`, new Uint8Array(await extrasResponse.arrayBuffer())); FS.chdir('/rwdir');
    engine.main();
    engine.Cmd_ExecuteString('developer ' + (new URLSearchParams(location.search).has('debug') ? '1' : '0'));
    const nickname = $('name').value.replace(/[^a-zA-Z0-9 _.-]/g, '').slice(0, 24) || 'Player';
    engine.Cmd_ExecuteString(`name "${nickname}"`); engine.Cmd_ExecuteString('setinfo "_vgui_menus" "0"');
    if ($('mode').value === 'multiplayer') engine.Cmd_ExecuteString('connect 127.0.0.1:8080');
    else engine.Cmd_ExecuteString(`map ${g.solo.map}`);
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
window.addEventListener('pagehide', () => { stopped = true; if (timer) clearInterval(timer); socket?.close(); });
