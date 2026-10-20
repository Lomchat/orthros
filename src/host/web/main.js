// Page side: manifest picker, canvases handed to the worker, input capture into the shared ring,
// audio worklet fed from the shared float ring, perf HUD, and a small window.orthros API for the
// headless harness (status, stats, screenshots, logs).
import { CTL, IN_RING, EV, AUDIO_RING_FRAMES, AUDIO_RATE } from '../browser-host.js';
import { mountHome } from './home.js';
import { loadBench, BenchRun } from './bench.js';
import { SummaryClock } from '../perf-summary.js';
import { netWaitText, fmtRate, fmtBytes, received } from './net-status.js';
import { resumeOnGesture, soundHintNeeded, AudioStats } from './sound.js';
import { PointerInput, winButton, cursorView } from './pointer.js';
import { SNAPSHOT_PREFIX, profileFiles, replaceProfile } from './data-store.js';
import { createShell, lockKeys } from './shell.js';
import { CloudSave } from './cloud-sync.js';
import { accountState } from './account.js';
import { pickLang } from './lang.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const headless = params.get('headless') === '1';
const state = { status: 'menu', loadT0: performance.now(), loadPct: 0, stats: null, logs: [], exitCode: null, crash: null, worker: null, ctl: null, inputRing: null, head: 0, mode: { width: 1024, height: 768 }, pointerLocked: false };
window.orthros = state;
/** The frame around the game (shell.js): created when a game starts, none headless. */
let shell = null, cloud = null;

// ---------------------------------------------------------------- the page's words (English or French: lang.js)
const lang = pickLang();
const TEXT = {
  en: {
    cannotRun: 'Orthros cannot run here', noBench: 'This measurement cannot run',
    exited: (t) => `${t} has exited`, exitCode: (c, r) => `exit code ${c}${r ? ` (${r})` : ''}`,
    crashed: (t) => `${t} stopped on an emulation error`, crashDetail: 'the report below describes the state at the fault',
    restart: 'Restart', fresh: 'Restart with a fresh game profile', freshTitle: 'the saved settings and saves are moved aside (kept), the game starts as on its first launch', back: 'Back to the games', freshing: 'moving the saved profile aside…',
    noIsolation: 'the page is not cross-origin isolated (SharedArrayBuffer unavailable): serve it with Orthros\' server (COOP/COEP headers)',
    noWebgl: 'WebGL 2 is unavailable (hardware acceleration disabled?)', noTail: 'this browser lacks WebAssembly tail calls: use a recent Chrome',
    subtitle: 'running from its original files, in your browser',
    steps: { files: 'Downloading the game files', code: 'Preparing the game\'s code', gfx: 'Compiling graphics shaders', boot: 'Starting the game' },
    tips: [
      'The first launch downloads the game files into this browser: the next ones start from its own copy, much faster.',
      'Full screen (button above, or Alt+Enter) gives the game the whole screen and keeps the mouse in it; hold Esc to leave.',
      'Signed in to Orthros, everyone playing this game on the server is on the same local network: in the game, Multiplayer → LAN shows their games.',
      'The game runs entirely in your browser, from its original files: nothing is installed.',
      'Signed in, your saves follow you: they are kept on your Orthros account and come back on any computer.',
    ],
    connecting: 'Connecting…', account: 'Checking your account\'s saves…', capture: 'Click the game to capture the mouse · Esc releases it · ⛶ for full screen',
    downloading: (mb) => `Downloading the game files — ${mb}`, preparing: 'Preparing the game\'s code…', starting: 'Starting the game…', read: 'read', received: 'received',
    paused: (t) => `${t} is paused while its window is inactive <small>click the game to resume</small>`,
    loading: (t, s, mips, mb) => `${t} is loading…<br><small>${s} s · emulated CPU ${mips} MIPS · game files ${mb}</small>`,
    preload: 'preloading', preloadTitle: 'game files downloaded ahead in the background: later screens and maps load faster',
    lan: (ip, n) => `The local network of the players of this game on this server — your address: ${ip}. ${n} player${n > 1 ? 's' : ''} connected: in the game, Multiplayer → LAN / Network shows their games.`,
    lanOff: 'Multiplayer: sign in to Orthros to join the local network of this game\'s players', lanOffShort: 'offline',
    again: 'Click the game again to capture the mouse', released: 'Mouse released · click the game to capture it again',
    lateTitle: 'A save on your account', lateText: (t) => `Your account already has a save of ${t}, different from this browser's. Restart with your account's save, or send this browser's one over it (the account's stays in its history)?`,
    lateAccount: 'Restart with the account\'s save', lateDevice: 'Keep this browser\'s save',
    panel: (f, mx, p99, s33, mips, disp, files, gl, clock) => `frame rate   ${f} fps\nworst frame  ${mx} ms (p99 ${p99} ms)\n>33 ms       ${s33} in the last 0.5 s\nemulated CPU ${mips} MIPS\ndisplay      ${disp}\ngame files   ${files}${gl}\n${clock}`,
  },
  fr: {
    cannotRun: 'Orthros ne peut pas fonctionner ici', noBench: 'Cette mesure ne peut pas être lancée',
    exited: (t) => `${t} s’est arrêté`, exitCode: (c, r) => `code de sortie ${c}${r ? ` (${r})` : ''}`,
    crashed: (t) => `${t} s’est arrêté sur une erreur d’émulation`, crashDetail: 'le rapport ci-dessous décrit l’état au moment de l’erreur',
    restart: 'Relancer', fresh: 'Relancer avec un profil de jeu neuf', freshTitle: 'les réglages et sauvegardes sont mis de côté (conservés), le jeu démarre comme à son premier lancement', back: 'Retour aux jeux', freshing: 'mise de côté du profil…',
    noIsolation: 'la page n’est pas isolée (SharedArrayBuffer indisponible) : servez-la avec le serveur d’Orthros (en-têtes COOP/COEP)',
    noWebgl: 'WebGL 2 est indisponible (accélération matérielle désactivée ?)', noTail: 'ce navigateur ne gère pas les appels terminaux WebAssembly : utilisez un Chrome récent',
    subtitle: 'depuis ses fichiers d’origine, dans ton navigateur',
    steps: { files: 'Téléchargement des fichiers du jeu', code: 'Préparation du code du jeu', gfx: 'Compilation des shaders', boot: 'Démarrage du jeu' },
    tips: [
      'Le premier lancement télécharge les fichiers du jeu dans ce navigateur : les suivants partent de sa copie, bien plus vite.',
      'Le plein écran (bouton en haut, ou Alt+Entrée) donne tout l’écran au jeu et y garde la souris ; maintiens Échap pour en sortir.',
      'Connecté à Orthros, tous ceux qui jouent à ce jeu sur le serveur sont sur le même réseau local : dans le jeu, Multijoueur → LAN montre leurs parties.',
      'Le jeu tourne entièrement dans ton navigateur, depuis ses fichiers d’origine : rien n’est installé.',
      'Connecté, tes sauvegardes te suivent : elles sont gardées sur ton compte Orthros et reviennent sur n’importe quel ordinateur.',
    ],
    connecting: 'Connexion…', account: 'Vérification des sauvegardes de ton compte…', capture: 'Clique dans le jeu pour capturer la souris · Échap la libère · ⛶ pour le plein écran',
    downloading: (mb) => `Téléchargement des fichiers du jeu — ${mb}`, preparing: 'Préparation du code du jeu…', starting: 'Démarrage du jeu…', read: 'lus', received: 'reçus',
    paused: (t) => `${t} est en pause tant que sa fenêtre est inactive <small>clique dans le jeu pour reprendre</small>`,
    loading: (t, s, mips, mb) => `${t} charge…<br><small>${s} s · processeur émulé ${mips} MIPS · fichiers du jeu ${mb}</small>`,
    preload: 'préchargement', preloadTitle: 'fichiers du jeu téléchargés d’avance en arrière-plan : les écrans et cartes suivants chargent plus vite',
    lan: (ip, n) => `Le réseau local des joueurs de ce jeu sur ce serveur — ton adresse : ${ip}. ${n} joueur${n > 1 ? 's' : ''} connecté${n > 1 ? 's' : ''} : dans le jeu, Multijoueur → LAN / Réseau montre leurs parties.`,
    lanOff: 'Multijoueur : connecte-toi à Orthros pour rejoindre le réseau local des joueurs de ce jeu', lanOffShort: 'hors ligne',
    again: 'Clique de nouveau dans le jeu pour capturer la souris', released: 'Souris libérée · clique dans le jeu pour la capturer de nouveau',
    lateTitle: 'Une sauvegarde sur ton compte', lateText: (t) => `Ton compte a déjà une sauvegarde de ${t}, différente de celle de ce navigateur. Relancer avec celle du compte, ou envoyer celle de ce navigateur par-dessus (celle du compte reste dans son historique) ?`,
    lateAccount: 'Relancer avec celle du compte', lateDevice: 'Garder celle de ce navigateur',
    panel: (f, mx, p99, s33, mips, disp, files, gl, clock) => `images/s      ${f}\npire image    ${mx} ms (p99 ${p99} ms)\n>33 ms        ${s33} sur les 0,5 dernières s\nCPU émulé     ${mips} MIPS\naffichage     ${disp}\nfichiers      ${files}${gl}\n${clock}`,
  },
}[lang];

/** Centered message over the stage: progress while the game starts, or an error (with its report) that stays. */
function showStatus(title, detail = '', report = null, error = false, restart = false) {
  const el = $('status');
  el.classList.remove('hidden'); el.classList.toggle('error', error);
  const [b, fresh, back] = el.querySelectorAll('button'); b.classList.toggle('hidden', !restart); b.onclick = () => location.reload();
  b.textContent = TEXT.restart; fresh.textContent = TEXT.fresh; fresh.title = TEXT.freshTitle; back.textContent = TEXT.back;
  back.classList.toggle('hidden', !restart || headless); back.onclick = backToGames;
  fresh.classList.toggle('hidden', !restart || !state.manifest || headless);
  fresh.onclick = async () => { fresh.disabled = true; fresh.textContent = TEXT.freshing; await setProfileAside(state.manifest).catch(() => {}); location.reload(); };
  el.querySelector('.title').textContent = title; el.querySelector('.detail').textContent = detail;
  const pre = el.querySelector('pre'); pre.classList.toggle('hidden', !report); pre.textContent = report ?? '';
}
function hideStatus() { $('status').classList.add('hidden'); }
/** The game list again (a fresh page: the worker and its memory go with the old one). */
function backToGames() {
  const u = new URL(location.href); u.searchParams.delete('manifest'); u.searchParams.delete('gameLang'); u.searchParams.set('menu', '');
  location.href = u.toString();
}
/**
 * The game's saved user profile (settings, saves: OPFS directory orthros-<manifest>) moved to orthros-<manifest>-aside-<time>,
 * so the next start begins with a fresh profile (a profile left in a bad state by an interrupted run can make every
 * start fail); nothing is deleted. The game file block store is kept.
 */
state.setProfileAside = (name) => setProfileAside(name ?? state.manifest); // (window.orthros.setProfileAside(): the same from the console)
async function setProfileAside(name) {
  const root = await navigator.storage.getDirectory();
  let src; try { src = await root.getDirectoryHandle('orthros-' + name); } catch { return; }
  const dst = await root.getDirectoryHandle(`orthros-${name}-aside-${new Date().toISOString().replace(/[:.]/g, '-')}`, { create: true });
  const copy = async (from, to) => {
    for await (const [n, h] of from.entries()) {
      if (h.kind === 'directory') await copy(h, await to.getDirectoryHandle(n, { create: true }));
      else { const w = await (await to.getFileHandle(n, { create: true })).createWritable(); await w.write(await h.getFile()); await w.close(); }
    }
  };
  await copy(src, dst);
  await root.removeEntry('orthros-' + name, { recursive: true });
}
/** What Orthros needs from the browser; the first missing piece, or null. */
function missingFeature() {
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') return TEXT.noIsolation;
  if (typeof OffscreenCanvas === 'undefined' || !new OffscreenCanvas(1, 1).getContext('webgl2')) return TEXT.noWebgl;
  // WASM tail calls (return_call_indirect): a module using one validates only where they are supported
  const tail = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 4, 4, 1, 112, 0, 1, 10, 9, 1, 7, 0, 65, 0, 19, 0, 0, 11]);
  if (!WebAssembly.validate(tail)) return TEXT.noTail;
  return null;
}

async function main() {
  const missing = missingFeature();
  if (missing) { $('menu').classList.add('hidden'); showStatus(TEXT.cannotRun, missing, null, true); return; }
  const config = await fetch('/api/config').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  state.telemetry = !!config.telemetry && !headless;
  state.version = config.version ?? null; // (the served build: telemetry is read with it)
  state.encodedRanges = !!config.encodedRanges && params.get('encoded') !== '0';
  state.programCache = !!config.programCache && params.get('programs') !== '0';
  state.regionCache = !!config.regionCache && params.get('regions') !== '0'; // (code regions of earlier sessions translated while the game waits; ?regions=0: off) // (GL programs of earlier sessions compiled ahead; ?programs=0: off)
  state.profileSeed = !!config.profileSeed && params.get('profileseed') !== '0'; // (shared first-launch profile: profile-seed.js; ?profileseed=0: off)
  state.prefetch = !!config.prefetch && state.encodedRanges && params.get('prefetch') !== '0'; // (learned background prefetch; ?prefetch=0: off) // (compressed game file ranges; ?encoded=0: plain Range requests)
  $('logToggle').onchange = () => { $('log').style.display = $('logToggle').checked ? 'block' : 'none'; };
  if (state.telemetry || params.has('bench')) state.envPromise = machine().then((e) => (state.env = e)); // (the machine, once: sent with the first telemetry batch)
  // ?bench=<name>: a scripted measurement of tools/scenarios/bench (bench.js, docs/real-machine-bench.md); ?manifest= picks one of its versions
  if (params.has('bench')) { await startBench(params.get('bench'), params.get('manifest')); return; }
  // the server's default game starts directly (a deployment for players); ?menu shows the picker
  const auto = params.get('manifest') ?? (params.has('menu') ? null : config.defaultManifest);
  if (auto) start(auto, params.get('gameLang')); else await showMenu();
}

/** Bench mode: the banner (a click starts it: audio may then play), then the game with the scenario's player. */
async function startBench(name, manifest) {
  let def;
  try { def = await loadBench(name, manifest); } catch (e) { showStatus(TEXT.noBench, e.message ?? String(e), null, true); return; }
  const run = state.bench = new BenchRun(def, {
    state, push, EV, typeText, headless, log, capture: () => capturePointer(),
    postWorker: (m) => state.worker?.postMessage(m),
    machine: () => state.envPromise ?? machine(),
    sendRecord: async (rec) => { if (!state.telemetry) return false; (state.queue ??= []).push({ t: Date.now(), ...rec }); return flushTelemetry(); },
  });
  const go = () => { run.begin(); start(def.manifest, params.get('gameLang')); };
  if (headless || params.get('benchauto') === '1') go(); else run.intro(go, backToGames);
}

/** The home screen (home.js): the game list, one card per manifest; started games hand over to start(). */
let home = null;
async function showMenu() {
  let last = null; try { last = localStorage.getItem('orthros.last'); } catch { /* no storage */ }
  home = mountHome({ onPlay: start });
  const load = async () => {
    home.setLoading();
    try {
      const res = await fetch('/api/manifests'); if (!res.ok) throw new Error(`HTTP ${res.status}`);
      home.setGames((await res.json()).filter((g) => !g.hidden || params.has('all')), last);
    } catch (e) { home.setError(String(e.message ?? e), load); }
  };
  await load();
}

async function start(name, language = null) {
  if (state.status !== 'menu') return;
  state.status = 'loading';
  try { localStorage.setItem('orthros.last', name); } catch { /* no storage */ }
  const sourcesReq = snapshotsOn() ? fetch('/api/snapshot-sources').then((r) => (r.ok ? r.json() : null)).catch(() => null) : null;
  const manifest = await (await fetch(`/api/manifest/${name}`)).json();
  if (manifest.launchUrl) { const portUrl = new URL(manifest.languageLaunchUrls?.[language] ?? manifest.launchUrl, location.href); if (language) portUrl.searchParams.set('gameLang', language); location.href = portUrl.href; return; } // (a browser port: its own page, docs/browser-ports.md)
  const options = manifest.languages ?? [];
  if (!options.includes(language)) {
    try { language = localStorage.getItem('orthros.gameLanguage.' + (manifest.gameId ?? name)); } catch { language = null; }
  }
  if (!options.includes(language)) language = options.includes('en') ? 'en' : options[0] ?? null;
  state.gameLanguage = language;
  if (!headless) { const u = new URL(location.href); u.searchParams.delete('menu'); u.searchParams.set('manifest', name); if (language) u.searchParams.set('gameLang', language); history.replaceState(null, '', u.toString()); } // (a reload keeps the selected version and language)
  const treeReq = fetch(`/api/tree/${name}`).then((r) => r.json());
  home?.destroy(); home = null; $('stage').classList.remove('hidden');
  state.title = manifest.name ?? name;
  // (headless: no header nor loading screen — the harness reads the stats, and screenshots the frame alone)
  if (headless) document.body.classList.add('nobar');
  else { makeShell(name, manifest, language); showLoader(name); }
  // the player's saves on the account (cloud-sync.js): the account's copy in place before the game reads its profile
  if (shell) {
    const st = await shell.ready;
    if (st.user) {
      shell.progress(null, TEXT.account);
      cloud = newCloud(name, st.user.username);
      // (a restart asked to take the account's copy: so, without asking again)
      let prefer = null; try { prefer = sessionStorage.getItem('orthros.preferAccount.' + name); sessionStorage.removeItem('orthros.preferAccount.' + name); } catch { /* none */ }
      const what = await cloud.pull().catch((e) => { log('warn', `account saves: ${e.message}`); return 'offline'; });
      if (what === 'conflict') { if (prefer) await cloud.resolve('account'); else await shell.resolveConflict(cloud); }
    }
  } else if (headless && params.get('cloud') === '1') {
    // (a harness run without the header, signed in: the account's saves as a player's — a conflict keeps the account's)
    const st = await accountState();
    if (st.user) {
      cloud = newCloud(name, st.user.username);
      const what = await cloud.pull().catch((e) => { log('warn', `account saves: ${e.message}`); return 'offline'; });
      if (what === 'conflict') await cloud.resolve('account');
      log('loader', `account saves (${st.user.username}): ${what}`);
    }
  }
  const tree = await treeReq;
  state.status = 'starting'; state.manifest = name;
  // the worker renders into its own OffscreenCanvases and posts complete frames as ImageBitmaps
  state.ctx2d = $('c2d').getContext('bitmaprenderer'); state.ctxGl = $('gl').getContext('bitmaprenderer'); state.ctxVideo = $('vid').getContext('bitmaprenderer'); $('vid').style.visibility = 'hidden'; // (no movie from a previous run)
  resizeTo(manifest.display.width, manifest.display.height);
  const ctlSab = new SharedArrayBuffer(CTL.SIZE * 4), inputSab = new SharedArrayBuffer(IN_RING * 4), audioSab = new SharedArrayBuffer(AUDIO_RING_FRAMES * 2 * 4);
  state.ctl = new Int32Array(ctlSab); state.inputRing = new Int32Array(inputSab);
  const worker = new Worker('/src/host/web/worker.js', { type: 'module' });
  state.worker = worker;
  worker.onmessage = (e) => onWorkerMessage(e.data);
  worker.onerror = (e) => log('crash', `worker error: ${e.message}`);
  const opts = { headless, gameLanguage: language, dxtHelpers: params.has('dxthelpers') ? Number(params.get('dxthelpers')) : undefined, asyncReads: params.get('asyncreads') !== '0', timeScale: Number(params.get('timescale') || 1), interp: params.get('interp') === '1', log: params.get('log') ? params.get('log').split(',') : undefined, cacheBlocks: Number(params.get('cache') || 256), dumpShaders: params.get('dump') === '1', captureFrame: Number(params.get('capture') || 0), captureDraws: params.get('capturedraws') === '1', burstFromId: Number(params.get('burstfrom') || 0), noCull: params.get('nocull') === '1', jitProfile: params.get('jitprof') === '1', glDiscard: params.get('gldiscard') === '1', watchTex: params.get('watchtex') || '', noF32: params.get('nof32') === '1', f32Off: params.get('f32off') || '', glValidate: params.get('glvalidate') === '1', offline: params.get('offline') === '1' || $('offlineToggle').checked, interpRange: params.get('interprange') || '', profileFiles: window.__orthrosProfile, opfs: params.get('opfs') === '1', slowFrom: Number(params.get('slowfrom') || 0), encodedRanges: state.encodedRanges, prefetch: state.prefetch, programCache: state.programCache, regionCache: state.regionCache, profileSeed: state.profileSeed, codeCache: params.get('codecache') !== '0', bgTranslate: params.get('bgjit') !== '0', audioMix: params.get('audiomix') || 'worklet', apiTimes: params.get('apitimes') === '1', dbg: [params.get('dbg'), state.bench ? 'ORTHROS_GL_COUNT=1' : ''].filter(Boolean).join(','), jitOpts: params.get('jitopts') || '', memPrefetch: params.get('memprefetch') === '1', netLog: params.get('netlog') === '1', lan: params.get('lan') === '1', session: state.session, glWorker: params.get('glworker') ?? undefined, netBw: savedNetBw() };
  // (this browser's snapshot of the game, docs/snapshot.md: the machine goes on from it)
  let snapshot = null;
  const sources = await sourcesReq;
  if (sources?.hash) {
    state.snapshotKey = await snapshotKey(sources.hash, name, manifest, tree, opts);
    snapshot = await loadSnapshot(name, state.snapshotKey);
    if (!snapshot) { snapshot = await sharedSnapshot(name, state.snapshotKey, language); if (snapshot) state.sharedSnapshotCopy = snapshot.slice(0); } // (kept as this player's once it applied)
    opts.snapshotAuto = true; // (the worker takes them as the game's loading goes on)
    opts.snapshotPublish = params.get('snapshot') === 'publish';
  }
  if (snapshot) log('loader', `snapshot of ${(snapshot.byteLength / 1048576).toFixed(1)} MiB found: the game goes on from it`);
  worker.postMessage({ type: 'start', name, manifest, tree, ctl: ctlSab, inputRing: inputSab, audioRing: audioSab, opts, snapshot, snapshotShared: !!state.sharedSnapshotCopy }, snapshot ? [snapshot] : []);
  setupInput();
  if (!headless || params.get('audio') === '1') setupAudio(audioSab, ctlSab).catch((e) => { state.audioStats.noteError(e.message ?? String(e)); log('warn', `audio unavailable: ${e.message}`); });
  if (performance.measureUserAgentSpecificMemory) { const tick = async () => { try { const m = await performance.measureUserAgentSpecificMemory(); state.memoryMB = Math.round(m.bytes / 1048576); } catch { /* not available */ } setTimeout(tick, 5000); }; tick(); }
}

function resizeTo(w, h) {
  state.mode = { width: w, height: h };
  const frame = $('frame');
  frame.style.width = w + 'px'; frame.style.height = h + 'px';
  for (const id of ['c2d', 'gl', 'vid']) { const c = $(id); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; } }
  fit();
}
function fit() {
  const { width: w, height: h } = state.mode;
  const bar = headless || document.fullscreenElement || !shell ? 0 : shell.bar.offsetHeight;
  const s = Math.min(innerWidth / w, (innerHeight - bar) / h, headless ? 1 : Infinity);
  const frame = $('frame');
  frame.style.transform = `scale(${s})`; frame.style.transformOrigin = 'center';
  // nearest-neighbour only for whole scale factors (crisp, even pixels); a fractional scale is filtered smoothly
  for (const c of frame.querySelectorAll('canvas')) c.style.imageRendering = Number.isInteger(s) ? 'pixelated' : 'auto';
  state.scale = s;
}
addEventListener('resize', fit);
document.addEventListener('fullscreenchange', fit);

/**
 * Snapshots of the game's machine (docs/snapshot.md). A session that did not start from one takes one once the game
 * settled (the worker's SnapshotWatch) and keeps it in this browser's OPFS once the session went on
 * (orthros-snapshot-<manifest>/machine.bin, then machine.json with its key). The next start of the game goes on from it
 * while its key is the same — Orthros' state-owning sources (/api/snapshot-sources), the game version's manifest and
 * files, the language and the options that change the machine; the worker then checks the profile files and the registry
 * the snapshot's machine saw. A player with no profile of the game yet starts from the server's shared one of the same
 * key when there is one (docs/snapshot.md, stage 3: made by a new player's session the server ran, ?snapshot=publish).
 * ?snapshot=0: none; headless runs: none unless ?snapshot=auto.
 * window.orthros.snapshot() asks the worker for one now ({ bytes, objects, pages, ms } or the fields it refused);
 * saveSnapshot() keeps it as the automatic one.
 */
const snapshotsOn = () => ['auto', 'publish'].includes(params.get('snapshot')) || (!headless && params.get('snapshot') !== '0');
const snapshotWaits = new Map(); let snapshotSeq = 0;
state.snapshot = () => new Promise((resolve) => { const id = ++snapshotSeq; snapshotWaits.set(id, resolve); state.worker?.postMessage({ type: 'snapshot', id }); });
state.saveSnapshot = async () => {
  const r = await state.snapshot();
  if (!r.bytes || !state.snapshotKey) return { ...r, saved: false, error: r.error ?? (r.bytes ? 'snapshots are off in this session' : undefined) };
  await storeSnapshot(state.manifest, state.snapshotKey, r.bytes);
  return { saved: true, bytes: r.bytes.byteLength, objects: r.objects, pages: r.pages, ms: r.ms, timing: r.timing };
};
/** The key a snapshot of game `name` is kept under (see above): a hex string. */
async function snapshotKey(sources, name, manifest, tree, opts) {
  const machine = { lang: opts.gameLanguage, timeScale: opts.timeScale, interp: opts.interp, interpRange: opts.interpRange, dbg: opts.dbg, jitOpts: opts.jitOpts, noF32: opts.noF32, f32Off: opts.f32Off };
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ sources, name, manifest, tree, machine })));
  return Array.from(new Uint8Array(d).subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
const snapshotDir = async (name, create = false) => (await navigator.storage.getDirectory()).getDirectoryHandle(SNAPSHOT_PREFIX + name, { create });
/** This browser's snapshot of game `name` when it was kept under `key`: its bytes, else null. */
async function loadSnapshot(name, key) {
  try {
    const dir = await snapshotDir(name), info = JSON.parse(await (await (await dir.getFileHandle('machine.json')).getFile()).text());
    if (info.key !== key) return null;
    const bytes = await (await (await dir.getFileHandle('machine.bin')).getFile()).arrayBuffer();
    return bytes.byteLength === info.bytes ? bytes : null;
  } catch { return null; }
}
/** Keep `bytes` as the snapshot of game `name` (its key written last: one half written is never used). */
async function storeSnapshot(name, key, bytes) {
  const dir = await snapshotDir(name, true);
  await dir.removeEntry('machine.json').catch(() => {});
  const b = await (await dir.getFileHandle('machine.bin', { create: true })).createWritable(); await b.write(bytes); await b.close();
  const j = await (await dir.getFileHandle('machine.json', { create: true })).createWritable(); await j.write(JSON.stringify({ key, bytes: bytes.byteLength, at: new Date().toISOString() })); await j.close();
}
/** Has this browser a profile of game `name` (files the game wrote)? */
async function hasProfile(name) {
  try { for await (const _ of (await (await navigator.storage.getDirectory()).getDirectoryHandle('orthros-' + name)).keys()) return true; } catch { /* none */ }
  return false;
}
/**
 * The server's shared snapshot of game `name` for `key` (stage 3), for a player with no profile of it: its bytes, or null
 * — none, or one that would come slower than the game starts (60 s at the connection's last measured rate).
 */
async function sharedSnapshot(name, key, lang) {
  if (params.get('snapshot') === 'publish' || await hasProfile(name)) return null;
  const ctl = new AbortController();
  try {
    const r = await fetch(`/api/snapshot/${encodeURIComponent(name)}?key=${key}&lang=${encodeURIComponent(lang ?? '')}`, { signal: ctl.signal });
    if (!r.ok) return null;
    const size = Number(r.headers.get('Content-Length')) || 0, bw = savedNetBw();
    if (bw && size / bw > 60) { ctl.abort(); log('loader', `shared snapshot not used: ${(size / 1048576).toFixed(0)} MB at ${(bw / 1048576).toFixed(1)} MB/s`); return null; }
    log('loader', `shared snapshot of this game: ${(size / 1048576).toFixed(1)} MB to download`);
    const bytes = await r.arrayBuffer();
    return new DataView(bytes).getUint32(0) === 0x4f534e50 ? bytes : null;
  } catch { return null; }
}
async function dropSnapshot(name) { await (await navigator.storage.getDirectory()).removeEntry(SNAPSHOT_PREFIX + name, { recursive: true }).catch(() => {}); }

function onWorkerMessage(m) {
  switch (m.type) {
    case 'snapshot':
      if (m.id !== 'auto') { snapshotWaits.get(m.id)?.(m); snapshotWaits.delete(m.id); break; }
      if (!m.bytes) { log('loader', `automatic snapshot refused: ${m.error}`); break; }
      state.snapshotPending = m.bytes; // (kept once the session went on: snapshot-keep)
      log('loader', `snapshot of the game taken: ${(m.bytes.byteLength / 1048576).toFixed(1)} MiB in ${m.ms.toFixed(0)} ms (${Object.entries(m.timing).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')})`);
      break;
    case 'snapshot-keep': {
      const bytes = state.snapshotPending; state.snapshotPending = null;
      if (bytes && state.snapshotKey) storeSnapshot(state.manifest, state.snapshotKey, bytes).then(() => { state.snapshotStored = true; state.snapshotsKept = (state.snapshotsKept ?? 0) + 1; state.snapshotKeptAt = Date.now(); log('loader', 'snapshot kept: the next start of this game goes on from it'); }, (e) => log('warn', `snapshot not kept: ${e.message}`));
      // (the server's publishing session: the server keeps it for new players, stage 3)
      if (bytes && state.snapshotKey && params.get('snapshot') === 'publish') {
        fetch(`/api/snapshot/${encodeURIComponent(state.manifest)}?key=${state.snapshotKey}&lang=${encodeURIComponent(state.gameLanguage ?? '')}&token=${encodeURIComponent(params.get('publishToken') ?? '')}`, { method: 'POST', body: bytes })
          .then((r) => { state.snapshotsPublished = (state.snapshotsPublished ?? 0) + (r.ok ? 1 : 0); log('loader', `snapshot published: HTTP ${r.status}`); }, (e) => log('warn', `snapshot not published: ${e.message}`));
      }
      break;
    }
    case 'snapshot-stale': state.sharedSnapshotCopy = null; dropSnapshot(state.manifest); break; // (the worker said why in its log; a new one is taken)
    case 'snapshot-drop': state.snapshotPending = null; break; // (the profile changed after it: taken again later)
    case 'snapshot-failed': // (a restore that failed midway: started again without the snapshot)
      log('crash', `the snapshot could not be restored: ${m.error}`); state.snapshotFailed = m.error;
      dropSnapshot(state.manifest).then(() => { if (!headless) location.reload(); });
      break;
    case 'log': log(m.kind, m.msg); break;
    case 'stdout': log('stdout', m.text); break;
    case 'started': if (state.sharedSnapshotCopy) { storeSnapshot(state.manifest, state.snapshotKey, state.sharedSnapshotCopy).catch(() => {}); state.sharedSnapshotCopy = null; } state.status = 'running'; state.firstLaunch = !!m.firstLaunch; if (m.profile?.length) telemetryEvent({ event: 'profile', files: m.profile }); break;
    case 'stats': state.stats = m; state.statsAt = Date.now(); m.seq = state.statsSeq = (state.statsSeq ?? 0) + 1; state.bench?.onStats(m); noteNet(m.net);
      if (m.frames !== state.lastFrames || m.videoFrames !== state.lastVideoFrames) { state.lastFrames = m.frames; state.lastVideoFrames = m.videoFrames; state.lastNewFrameAt = Date.now(); } // (a movie playing: new pictures, not a loading wait)
      if (!headless && state.status !== 'crashed' && state.status !== 'exited') { if ((m.d3d?.frames ?? 0) > 0 || m.frames >= 30 || m.videoFrames > 0) hideLoader(); else updateLoader(m); } /* (a window's first paint is not the game's first image: Direct3D's first frame, a few GDI frames, or a movie's first picture) */ if (state.audio) { m.audioState = state.audio.state; m.audioUnderruns = Atomics.load(state.ctl, CTL.AUDIO_UNDERRUNS); } noteAudio(m); recordSample(m); renderHud(); break;
    case 'gl-port': m.port.onmessage = (e) => onWorkerMessage(e.data); break; // (the render worker's frames, logs, captures)
    case 'frame': { const c = $(m.layer === 'gl' ? 'gl' : m.layer === 'video' ? 'vid' : 'c2d'); if (c.width !== m.bitmap.width || c.height !== m.bitmap.height) { c.width = m.bitmap.width; c.height = m.bitmap.height; } (m.layer === 'gl' ? state.ctxGl : m.layer === 'video' ? state.ctxVideo : state.ctx2d).transferFromImageBitmap(m.bitmap); break; }
    case 'video': $('vid').style.visibility = m.visible ? 'visible' : 'hidden'; break; // (a movie's video window, above the game's layers: quartz.js)
    case 'mode': resizeTo(m.width, m.height); break;
    case 'lan': { state.lan = { ip: m.ip, peers: m.peers, refused: !!m.refused }; const el = $('tbLan'); if (!el) break; el.classList.toggle('hidden', (!m.ip && !m.refused) || headless); el.classList.toggle('off', !!m.refused); el.querySelector('b').textContent = m.refused ? TEXT.lanOffShort : m.peers; el.title = m.refused ? TEXT.lanOff : TEXT.lan(m.ip, m.peers); break; }
    case 'profile-changed': profileChanged(); break;
    case 'title': document.title = m.title || 'Orthros'; break;
    case 'cursor': state.cursorVisible = m.visible; applyCursor(); break;
    case 'cursor-pos': pointer.cursorReport(m.x, m.y, m.seq); if (state.pointerLocked) drawSoftCursor(); break; // (the guest cursor: SetCursorPos warps, clipping, the moves taken)
    case 'cursor-def': { const frames = m.frames.map((f) => { const u8 = new Uint8Array(f.png); let bin = ''; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return `url(data:image/png;base64,${btoa(bin)}) ${f.hotX} ${f.hotY}, auto`; }); (state.cursors ??= new Map()).set(m.id, { frames, steps: m.steps }); break; }
    case 'cursor-set': state.cursor = m.id !== undefined ? { id: m.id } : { system: m.system }; applyCursor(); break;
    case 'gl': $('gl').style.zIndex = m.active ? '2' : '0'; $('c2d').style.zIndex = m.active ? '1' : '2'; $('gl').style.visibility = m.active ? 'visible' : 'hidden'; break;
    case 'audio-voices': state.audioVoices = { type: 'voices', memory: m.memory, voices: m.voices }; state.audioNode?.port.postMessage(state.audioVoices); break; // (the AudioWorklet mixes the game's sound buffers itself)
    case 'exit': $('busy').classList.add('hidden'); hideLoader(true); releaseGuestCursor(); telemetryEvent({ event: 'exit', code: m.code, reason: m.reason ?? null, report: m.report ? String(m.report).slice(0, 30000) : null, log: state.logs.slice(-80).map((l) => l.slice(0, 600)) }); if (m.report) log('crash', m.report); state.status = 'exited'; state.exitCode = m.code; log('crash', `process exited with code ${m.code}${m.reason ? ` (${m.reason})` : ''}`); if (!headless) showStatus(TEXT.exited(state.title), TEXT.exitCode(m.code, m.reason), null, m.code !== 0, true); cloud?.push(); break;
    case 'crash': $('busy').classList.add('hidden'); hideLoader(true); releaseGuestCursor(); telemetryEvent({ event: 'crash', report: String(m.report).slice(0, 30000), log: state.logs.slice(-80).map((l) => l.slice(0, 600)) }); state.status = 'crashed'; state.crash = m.report; log('crash', m.report); if (!headless) showStatus(TEXT.crashed(state.title), TEXT.crashDetail, m.report, true, true); break;
    case 'report': state.report = m.text; log('report', m.text); break;
    case 'regions': state.regions = m.text; break;
    case 'corpus': state.corpus = m.text; break;
    case 'profile': state.profile = m.files; break;
    case 'frames': state.frames = m.text; log('frames', m.text); break;
    // the options the worker runs with (render worker, asynchronous reads, ...): with the build version, the context of
    // this session's frame measurements
    case 'perf-options': state.perfOptions = m.options; telemetryEvent({ event: 'options', version: state.version, options: m.options }); break;
    case 'phase': (state.phases ??= []).push(m.report); if (state.phases.length > 100) state.phases.shift(); state.bench?.onPhase(m.report); break; // (harness marks: frame report of the phase)
    case 'dump': { const u8 = new Uint8Array(m.data); let bin = ''; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); (state.dumps ??= []).push({ name: m.name, data: btoa(bin) }); break; } // frame-capture PNGs, collected by the headless harness
  }
}

/** Windows system cursor ids (IDC_*) as CSS cursors */
const SYSTEM_CURSORS = { 32512: 'default', 32513: 'text', 32514: 'wait', 32515: 'crosshair', 32516: 'default', 32642: 'nwse-resize', 32643: 'nesw-resize', 32644: 'ew-resize', 32645: 'ns-resize', 32646: 'move', 32648: 'not-allowed', 32649: 'pointer', 32650: 'progress', 32651: 'help' };
/** The game stopped: its cursor goes with it (a game that hid it must not leave the page without one) and the mouse is released. */
function releaseGuestCursor() {
  if (document.pointerLockElement) document.exitPointerLock();
  state.cursorVisible = undefined; state.cursor = null; applyCursor();
}
/** Show the guest cursor on the frame (inherited by both canvases): hidden, a system cursor, or an animated image cursor. */
function applyCursor() {
  clearTimeout(state.cursorTimer);
  const frame = $('frame');
  $('c2d').style.cursor = '';
  const view = cursorView(state.cursorVisible, state.pointerLocked);
  if (!view.soft && view.css === 'none') { frame.style.cursor = 'none'; drawSoftCursor(); return; }
  const cur = state.cursor, def = cur?.id !== undefined ? state.cursors?.get(cur.id) : null;
  if (!def) { frame.style.cursor = view.css === 'none' ? 'none' : SYSTEM_CURSORS[cur?.system] ?? 'default'; drawSoftCursor(); return; }
  let step = 0;
  const show = () => {
    const s = def.steps[step % def.steps.length];
    frame.style.cursor = view.css === 'none' ? 'none' : def.frames[s.frame];
    state.softStep = step; drawSoftCursor();
    if (def.steps.length > 1) { step++; state.cursorTimer = setTimeout(show, Math.max(16, s.ms)); }
  };
  show();
}

/** Emulator warnings and graphics failures sent to the server as they happen (the first 60 of a session): what a
 * player's GPU / browser rejects (a shader, a GL error), an API the game needed, a slow program build. */
const TELEMETRY_LOG = /^(warn|crash)$|^gfx$/;
const TELEMETRY_GFX = /error|fail|lost|restor|built in|unsupported|unavailable|GL timing/i; // (GL timing: the ?dbg=ORTHROS_GL_TIME=N@F probe on a player's GPU)
function log(kind, msg) {
  if (state.telemetry && TELEMETRY_LOG.test(kind) && (kind !== 'gfx' || TELEMETRY_GFX.test(msg)) && (state.logSent = (state.logSent ?? 0) + 1) <= 60) (state.queue ??= []).push({ t: Date.now(), event: 'log', kind, msg: String(msg).slice(0, String(msg).includes('\n') ? 24000 : 4000) });
  // frames of 150 ms and more with what happened during them (translation, program builds, file reads, waits): the
  // first 150 of a session, to tell a player's hitches apart (a frame without any of these: collection or the GPU)
  else if (state.telemetry && kind === 'slowframe' && Number(/ ([\d.]+)ms:/.exec(msg)?.[1]) >= 150 && (state.slowSent = (state.slowSent ?? 0) + 1) <= 150) (state.queue ??= []).push({ t: Date.now(), event: 'slow', msg: String(msg).slice(0, 1000) });
  const line = `[${kind}] ${msg}`;
  state.logs.push(line); if (state.logs.length > 5000) state.logs.shift();
  if (headless || window.__orthrosConsoleLog) console.log(line); // (__orthrosConsoleLog: the harness's --ui runs keep the log)
  const el = $('log');
  if (el.style.display !== 'none') { el.textContent += line + '\n'; el.scrollTop = el.scrollHeight; }
}

// ---------------------------------------------------------------- network
/** the link rate this browser measured last time (bytes/s): the worker's estimate until it measures its own */
function savedNetBw() { try { const v = Number(localStorage.getItem('orthros.netBw')); return v > 0 ? v : undefined; } catch { return undefined; } }
/** The worker's connection figures: the rate kept for the next visit (written when the page goes), the last time the game waited. */
function noteNet(net) {
  if (!net) return;
  if (net.waiting) state.netWaitAt = Date.now();
  if (net.measured && net.bw > 0) { state.netBw = Math.round(net.bw); if (!state.netSaveHooked) { state.netSaveHooked = true; addEventListener('pagehide', () => { try { localStorage.setItem('orthros.netBw', String(state.netBw)); } catch { /* storage off */ } }); } }
}
/** the game waits for the network now (or did within the last 2 s: no flicker between two reads) */
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const netWaiting = (s) => !!s?.net && (s.net.waiting || Date.now() - (state.netWaitAt ?? 0) < 2000);

// ---------------------------------------------------------------- the frame around the game (shell.js)
/**
 * The header over the game (its indicators: the background preload, the players of the game's local network), the
 * loading screen, the passing messages; quitting saves the profile on the account first.
 */
function makeShell(name, manifest, language) {
  const pre = document.createElement('div');
  pre.className = 'pill hidden'; pre.id = 'tbPreload'; pre.title = TEXT.preloadTitle; pre.innerHTML = `${TEXT.preload} <b>0%</b><i><u></u></i>`;
  const lan = document.createElement('div');
  lan.className = 'pill hidden'; lan.id = 'tbLan'; lan.innerHTML = '<span class="dot"></span>LAN <b>1</b>';
  shell = createShell({
    title: state.title, version: manifest.version, gameLanguage: language, cover: manifest.cover || manifest.coverFile ? `/api/cover/${encodeURIComponent(name)}` : null,
    subtitle: TEXT.subtitle, steps: Object.entries(TEXT.steps).map(([k, label]) => ({ k, label })), tips: TEXT.tips, extras: [pre, lan],
    onPerf: () => $('perfPanel').classList.toggle('hidden'), onFullscreen: () => enterPlayMode(), onMouse: () => capturePointer(),
    onQuit: () => saveNow(), saves: () => cloud,
    onSignedIn: (user) => lateSignIn(name, user),
  });
  window.orthrosShell = shell;
}
/** The account's copy of this game's profile (cloud-sync.js): this browser's OPFS copy, or the running game's own. */
function newCloud(name, username) {
  const running = () => (['running', 'starting'].includes(state.status) && state.manifest === name ? state : null);
  return new CloudSave({ game: name, user: username, read: () => profileFiles(name, running()), write: (files) => replaceProfile(name, files, running()), onStatus: (s) => { shell?.setSave(s); if (!shell) log('loader', `account saves: ${s.state}${s.version ? ' v' + s.version : ''}`); } });
}
/** The profile sent to the account now (back to the games, the page hidden): false when it could not be. */
async function saveNow() {
  if (!cloud) return true;
  const st = await cloud.push().catch(() => null);
  return !!st && !['error', 'toobig'].includes(st.state);
}
/** The game's profile changed (the worker wrote it to this browser's copy): sent to the account a while after. */
function profileChanged() {
  if (!cloud || state.cloudTimer) return;
  state.cloudTimer = setTimeout(() => { state.cloudTimer = null; cloud?.push(); }, 45000);
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && cloud && state.status === 'running') cloud.push(); });
/**
 * Signed in while the game runs: its profile sent to the account, unless the account already has another one — then
 * the player chooses: restart with the account's (the page starts again, the copy put in place before the game), or
 * this browser's sent over it.
 */
async function lateSignIn(name, user) {
  if (cloud) return;
  cloud = newCloud(name, user.username);
  const head = await cloud.remoteHead().catch(() => null);
  cloud.remoteHash = head;
  if (!head) { cloud.push(); return; }
  const choice = await shell.ask({ title: TEXT.lateTitle, text: TEXT.lateText(state.title), buttons: [{ value: 'account', label: TEXT.lateAccount, primary: true }, { value: 'device', label: TEXT.lateDevice }] });
  if (choice === 'account') { try { sessionStorage.setItem('orthros.preferAccount.' + name, '1'); } catch { /* none */ } location.reload(); }
  else if (choice === 'device') cloud.resolve('device');
  else cloud.set({ state: 'conflict' });
}

// ---------------------------------------------------------------- loading screen
/** The loading screen of a game: its cover blurred behind, the progress of the work done before its first image. */
function showLoader() {
  shell.showLoader(); shell.progress(0, TEXT.connecting);
  state.loadT0 = performance.now(); state.loadPct = 0;
}
function hideLoader(now = false) {
  if (!shell || shell.loader.classList.contains('hidden')) return;
  if (!now) { try { localStorage.setItem('orthros.boot.' + state.manifest, String(Math.round((performance.now() - state.loadT0) / 1000))); } catch { /* no storage */ } }
  shell.hideLoader(now);
  if (now) return;
  shell.running = true; shell.setMouse(state.pointerLocked);
  if (!state.benchActive) toast(TEXT.capture, 7000); // (a bench plays alone: its summary says it)
}
const fmtMB = (mb) => (mb >= 1000 ? (mb / 1024).toFixed(1) + ' GB' : Math.round(mb) + ' MB');
/**
 * Progress while the game starts: the files learned from earlier sessions (downloaded ahead), the code regions
 * translated ahead, the shader programs compiled ahead, then the game's own start (until its first image). Each part
 * weighs by its usual share of the wait; parts without anything to do are left out; the bar never goes back.
 */
function updateLoader(m) {
  if (!shell || shell.loader.classList.contains('hidden')) return;
  const L = m.load ?? {}, now = performance.now(), secs = (now - state.loadT0) / 1000;
  const set = (k, st, v) => shell.step(k, st, v);
  const parts = [];
  // files
  const pf = L.pfTotal ? Math.min(1, L.pfDone / L.pfTotal) : null;
  const prev = state.lastLoad; state.lastLoad = { t: now, mb: L.pfMB ?? m.ioMB ?? 0 };
  const speed = prev && now > prev.t ? Math.max(0, (state.lastLoad.mb - prev.mb) / ((now - prev.t) / 1000)) : 0;
  state.speed = state.speed == null ? speed : state.speed * 0.7 + speed * 0.3;
  if (pf !== null) { parts.push([0.45, pf]); set('files', L.pfFinished || pf >= 1 ? 'done' : 'active', `${fmtMB(L.pfMB ?? 0)}${!L.pfFinished && state.speed > 0.05 ? ` · ${state.speed.toFixed(1)} MB/s` : ''}`); }
  else set('files', (m.ioMB ?? 0) > 0 ? 'active' : '', `${fmtMB(m.ioMB ?? 0)} ${TEXT.read}`);
  if (m.net && (m.net.bw > 0 || received(m.net) > 0)) set('files', netWaiting(m) ? 'active' : shell.loader.querySelector('li[data-k="files"]').className, `${fmtBytes(received(m.net))} ${TEXT.received}${m.net.bw > 0 ? ` · ${fmtRate(m.net.bw)}` : ''}`);
  // code
  const rg = L.rgTotal ? Math.min(1, L.rgDone / L.rgTotal) : null;
  if (rg !== null) { parts.push([0.15, rg]); set('code', rg >= 1 ? 'done' : 'active', `${Math.round(rg * 100)}%`); } else set('code', 'skip', '');
  // shaders
  const pg = L.pgTotal ? Math.min(1, L.pgDone / L.pgTotal) : null;
  void pg; set('gfx', 'skip', ''); // (the shaders learned earlier compile along the first frames: not part of this wait)
  // the game's own start: an estimate from the time its last start took in this browser (else ~60 s), completed by
  // its first image — a curve that slows down rather than stops when the estimate is short
  const T = state.bootEstimate ??= (() => { try { return Number(localStorage.getItem('orthros.boot.' + state.manifest)) || 60; } catch { return 60; } })();
  const boot = Math.min(0.97, 1 - Math.exp(-2.2 * secs / T));
  parts.push([0.4, boot]); set('boot', 'active', `${Math.round(secs)} s · ${Math.round(m.mips)} MIPS`);
  const wsum = parts.reduce((a, [w]) => a + w, 0), p = parts.reduce((a, [w, f]) => a + w * f, 0) / wsum;
  state.loadPct = Math.max(state.loadPct, Math.min(99, Math.floor(p * 100)));
  const nw = netWaiting(m) ? netWaitText({ ...m.net, waiting: true }, lang) : null;
  shell.progress(state.loadPct, nw ? `${nw.title} · ${nw.detail}` : pf !== null && pf < 1 && !L.pfFinished ? TEXT.downloading(fmtMB(L.pfMB ?? 0)) : rg !== null && rg < 1 ? TEXT.preparing : TEXT.starting);
}
function toast(text, ms = 5000) { shell?.toast(text, ms); }
state.toast = toast;

/**
 * The header's live figures: frames per second (coloured against 30), the last minute as a small graph, the worst
 * frame and p99; the background preload; click for details. Also the game's own loading waits (#busy).
 */
function renderHud() {
  const s = state.stats; if (!s || !shell) return;
  const bar = shell.bar, fpsEl = bar.querySelector('.fps'), sub = bar.querySelector('.sub'), panel = $('perfPanel');
  const clock = new Date().toLocaleTimeString(lang);
  const still = s.frames > 0 && state.lastNewFrameAt ? (Date.now() - state.lastNewFrameAt) / 1000 : 0;
  const busy = $('busy'), paused = !document.hasFocus(), showBusy = state.status === 'running' && shell.loader.classList.contains('hidden') && (still >= 3 || (paused && s.frames > 0));
  busy.classList.toggle('hidden', !showBusy);
  const nw = showBusy && !paused && netWaiting(s) ? netWaitText({ ...s.net, waiting: true }, lang) : null;
  if (showBusy) busy.innerHTML = paused ? TEXT.paused(esc(state.title))
    : nw ? `${esc(nw.title)}<br><small>${esc(nw.detail)} · ${Math.round(still)} s</small>`
    : TEXT.loading(esc(state.title), Math.round(still), Math.round(s.mips), fmtMB(s.ioMB ?? 0));
  // background preload still going after the start
  const L = s.load ?? {}, pre = $('tbPreload');
  const pending = L.pfTotal > 0 && !L.pfFinished && L.pfDone < L.pfTotal && s.frames > 0;
  pre.classList.toggle('hidden', !pending);
  if (pending) { const q = Math.floor(100 * L.pfDone / L.pfTotal); pre.querySelector('b').textContent = q + '%'; pre.querySelector('u').style.width = q + '%'; }
  let f = 0, cls = '';
  if (paused && s.frames > 0) { fpsEl.textContent = '❚❚'; fpsEl.className = 'fps'; sub.textContent = shell.S.paused; }
  else if (!(s.frames > 0) || (still >= 3 && s.frames < 300)) { fpsEl.textContent = '…'; fpsEl.className = 'fps'; sub.textContent = `${shell.S.loadingShort}\n${Math.round(s.mips)} MIPS`; }
  else {
    f = hudFps(); cls = f >= 29.5 ? 'good' : f >= 20 ? 'warn' : 'bad';
    fpsEl.textContent = f.toFixed(0); fpsEl.className = 'fps ' + cls;
    const last = state.samples[state.samples.length - 1];
    const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
    sub.textContent = `p99 ${ms(s.frameP99)}\nmax ${ms(last?.max ?? 0)}`;
  }
  drawHudGraph(bar.querySelector('canvas'), false);
  if (!panel.classList.contains('hidden')) {
    drawHudGraph(panel.querySelector('canvas'), true);
    const last = state.samples[state.samples.length - 1];
    panel.querySelector('.txt').textContent = TEXT.panel(f.toFixed(1), Math.round(last?.max ?? 0), Math.round(s.frameP99), last?.s33 ?? 0, Math.round(s.mips), s.d3d ? `${s.d3d.w}x${s.d3d.h}` : '-',
      `${fmtMB(s.ioMB ?? 0)}${L.pfTotal ? ` (+${fmtMB(L.pfMB ?? 0)})` : ''}`, s.gl ? `\nrender ${s.gl.replayMs !== undefined ? 'worker' : ''}  waits ${Math.round(s.gl.gpuWaitMs)} ms, replay ${Math.round(s.gl.replayMs ?? 0)} ms` : '', clock);
  }
}
/** frames per second over the last second (the stats arrive every ~0.5 s) */
function hudFps() {
  const a = state.samples, n = a.length; if (!n) return 0;
  let frames = 0, t = 0; for (let i = n - 1; i >= 0 && t < 1; i--) { frames += a[i].fps * a[i].dt; t += a[i].dt; }
  return t ? frames / t : 0;
}
function drawHudGraph(cv, big = false) {
  const g = cv.getContext('2d'), w = cv.width, h = cv.height, a = state.samples, top = 60;
  g.clearRect(0, 0, w, h);
  g.fillStyle = big ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.04)'; g.fillRect(0, 0, w, h);
  const y = (v) => h - 1 - Math.min(v, top) / top * (h - 2);
  g.strokeStyle = 'rgba(255,255,255,0.25)'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(0, y(30)); g.lineTo(w, y(30)); g.stroke(); g.setLineDash([]);
  const span = 120, x0 = w - Math.min(a.length, span) * (w / span); // (the last ~60 s)
  g.strokeStyle = '#8fd18f'; g.beginPath();
  a.slice(-span).forEach((p, i) => { const x = x0 + i * (w / span); if (i) g.lineTo(x, y(p.fps)); else g.moveTo(x, y(p.fps)); });
  g.stroke();
  g.fillStyle = '#ff6b6b';
  a.slice(-span).forEach((p, i) => { if (p.s50 > 0) g.fillRect(x0 + i * (w / span), 0, 2, 4); });
}

// ---------------------------------------------------------------- measurements sent to the server (--telemetry)
state.samples = [];
state.audioStats = new AudioStats();
state.session = Math.random().toString(36).slice(2, 10);
/** One stats message (~0.5 s) as a sample: kept for the display, queued for the server. */
function recordSample(m) {
  const d3dDraws = m.d3d?.draws ?? 0, prev = state.lastDraws ?? d3dDraws; state.lastDraws = d3dDraws;
  // shader programs built since the last sample and the time spent (a first use stalls the frame: ANGLE translates them)
  const progs = m.d3d?.programs ?? 0, progMs = m.d3d?.programMs ?? 0, pp = state.lastProg ?? { n: progs, ms: progMs }; state.lastProg = { n: progs, ms: progMs };
  const jitMs = m.jitMs ?? 0, pj = state.lastJitMs ?? jitMs; state.lastJitMs = jitMs;
  // (busy: % of the interval the worker spent running the game; jit: ms spent translating code in the interval)
  const smp = { t: Date.now(), dt: m.dt ?? 0.5, fps: m.fps, busy: m.busy ?? null, jit: jitMs - pj, max: m.frameMax ?? 0, s33: m.slow33 ?? 0, s50: m.slow50 ?? 0, p99: m.frameP99, mips: Math.round(m.mips), api: Math.round(m.apiPerSec), draws: d3dDraws - prev, io: m.ioMB ?? 0, net: m.netMs ?? 0, netReq: m.netReq ?? 0, prog: progs - pp.n, progMs: progMs - pp.ms, frames: m.frames, st: state.status, mem: state.memoryMB ?? null, au: m.audioUnderruns ?? null, fs: !!document.fullscreenElement, vis: document.visibilityState === 'visible', ...(m.net ? { bw: m.net.bw, nw: m.net.waiting ? 1 : 0, rx: Math.round(received(m.net) / 1048576) } : {}) }; // (bw: measured link bytes/s, nw: the game waits for the network, rx: MB received)
  // frame accounting of the interval (frame-acct.js): mean work and time by category per frame (ms), the slow frames'
  // categories summed and the worst one [ms, work ms, categories] — what made frames slow
  const fa = m.acct; if (fa) { smp.w = fa.w; smp.c = fa.c; if (fa.sc) { smp.sc = fa.sc; smp.wf = fa.wf; } }
  state.samples.push(smp); if (state.samples.length > 600) state.samples.shift();
  if (!state.telemetry) return;
  (state.queue ??= []).push(smp);
  // every ~20 s a summary of the frames (perf-summary.js: percentiles, slow frames, time by category, draws, GPU time,
  // GL calls, render worker waits), at most 720 per session
  const sum = (state.summaries ??= new SummaryClock()).add(m, { t: smp.t, visible: smp.vis, fullscreen: smp.fs, status: state.status });
  if (sum) state.queue.push({ t: smp.t, event: 'summary', ...sum, audio: state.audioStats.take() }); // (audio: sound.js AudioStats — context, worklet, mix level, buffers)
  if (!state.flushTimer) state.flushTimer = setTimeout(flushTelemetry, 10000);
}
function telemetryEvent(ev) { if (!state.telemetry) return; (state.queue ??= []).push({ t: Date.now(), ...ev }); flushTelemetry(); }
/** Send the queued records; resolves to whether the server took them. */
function flushTelemetry() {
  state.flushTimer = null;
  const samples = state.queue ?? []; state.queue = [];
  if (!samples.length && state.envSent) return Promise.resolve(true);
  const body = { session: state.session, game: state.manifest ?? null, samples };
  if (!state.envSent) { state.envSent = true; body.env = state.env ?? environment(); }
  return fetch('/api/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true }).then((r) => r.ok, () => false);
}
addEventListener('pagehide', () => { if (state.telemetry) flushTelemetry(); });
/**
 * What the measurements depend on: browser, GPU (WebGL's unmasked renderer and vendor), screen, cores, memory,
 * cross-origin isolation, the browser's audio decoder and AudioWorklet. Nothing else is collected.
 */
function environment() {
  let gpu = null, gpuVendor = null;
  try { const gl = new OffscreenCanvas(1, 1).getContext('webgl2'); const ext = gl.getExtension('WEBGL_debug_renderer_info'); gpu = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER); gpuVendor = gl.getParameter(ext ? ext.UNMASKED_VENDOR_WEBGL : gl.VENDOR); gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* unknown */ }
  return { version: state.version ?? null, ua: navigator.userAgent, gpu, gpuVendor, cores: navigator.hardwareConcurrency ?? null, memGB: navigator.deviceMemory ?? null, screen: `${screen.width}x${screen.height}@${devicePixelRatio}`, window: `${innerWidth}x${innerHeight}`, coi: !!globalThis.crossOriginIsolated, audioDecoder: typeof globalThis.AudioDecoder === 'function', audioWorklet: typeof globalThis.AudioWorkletNode === 'function' }; // (audioDecoder: WebCodecs, the MP3 of movies and streams)
}
/** environment() with the WebGPU adapter's description when the browser has one (asked once, 2 s at most). */
async function machine() {
  const env = environment();
  if (!navigator.gpu) { env.webgpu = null; return env; }
  try {
    const ad = await Promise.race([navigator.gpu.requestAdapter(), new Promise((r) => setTimeout(() => r(undefined), 2000))]);
    if (ad === undefined) env.webgpu = { state: 'timeout' };
    else if (!ad) env.webgpu = { state: 'no adapter' };
    else { const i = ad.info ?? (ad.requestAdapterInfo ? await ad.requestAdapterInfo() : {}); env.webgpu = { vendor: i.vendor || null, architecture: i.architecture || null, device: i.device || null, description: i.description || null, fallback: !!(i.isFallbackAdapter ?? ad.isFallbackAdapter) }; }
  } catch { env.webgpu = { state: 'error' }; }
  return env;
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
window.orthrosInput = { push, EV, typeText, get pointer() { return pointer; } }; // (pointer: the harness's captured-mouse moves, pointer.js)

/** The page's mouse → the input ring (pointer.js): captured relative motion, or the free pointer's position. */
const pointer = new PointerInput((type, a, b, c) => push(type, a, b, c), () => state.mode);
state.pointer = pointer;
/** A mouse event's position in the game's screen pixels (unclamped: the page's margins are outside the screen). */
function screenPos(e) {
  const r = $('c2d').getBoundingClientRect(), s = state.scale || 1;
  return [(e.clientX - r.left) / s, (e.clientY - r.top) / s];
}
/**
 * Play mode: fullscreen + pointer lock (the mouse cannot leave the game, screen-edge scrolling works) + keyboard lock
 * (Escape and the browser's shortcut keys reach the game; holding Esc leaves fullscreen — lockKeys). The guest cursor
 * is then drawn by the page (#softcursor).
 */
/**
 * Capture the mouse (pointer lock): it stays in the game, which gets its moves, the page draws the guest cursor
 * (#softcursor). With the system's pointer acceleration, as the desktop cursor moves (no unadjustedMovement).
 */
async function capturePointer() {
  if (document.pointerLockElement || headless) return;
  try { await $('c2d').requestPointerLock(); }
  catch { if (state.status === 'running') toast(TEXT.again, 3000); } // (denied: released a moment ago, or no gesture)
}
state.capturePointer = capturePointer;
async function enterPlayMode() {
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { /* not allowed */ }
  await lockKeys();
  await capturePointer();
}
function drawSoftCursor() {
  const el = $('softcursor');
  if (!cursorView(state.cursorVisible, state.pointerLocked).soft) { el.style.display = 'none'; return; }
  const cur = state.cursor, def = cur?.id !== undefined ? state.cursors?.get(cur.id) : null;
  const frame = def ? def.frames[def.steps[(state.softStep ?? 0) % def.steps.length].frame] : null;
  const url = frame ? frame.match(/url\((.*?)\) (\d+) (\d+)/) : null;
  if (url) { if (el.src !== url[1]) el.src = url[1]; el.style.marginLeft = -url[2] + 'px'; el.style.marginTop = -url[3] + 'px'; }
  else { if (!el.dataset.arrow) { el.dataset.arrow = '1'; el.src = ARROW; } el.style.marginLeft = el.style.marginTop = '0px'; }
  el.style.display = 'block';
  el.style.left = pointer.vx + 'px'; el.style.top = pointer.vy + 'px';
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
  // (a bench running: the player's mouse, keys and focus changes do not reach the game — bench.js plays the scenario)
  const live = () => state.status === 'running' && !state.benchActive;
  document.addEventListener('mousemove', (e) => {
    if (!live()) return;
    if (state.pointerLocked) {
      if (state.lockFresh) { state.lockFresh = false; return; } // (the first move of a capture: its movement is measured from the pointer's position before the lock in some browsers — a spurious jump)
      pointer.lockedMove(e.movementX, e.movementY, state.scale || 1); drawSoftCursor();
    }
    else pointer.freeMove(...screenPos(e));
  });
  document.documentElement.addEventListener('mouseleave', () => pointer.left()); // (the pointer left the window)
  c.addEventListener('mousedown', (e) => {
    if (!live()) return;
    pointer.button(true, winButton(e.button), state.pointerLocked, ...screenPos(e)); e.preventDefault();
    // a click in the game captures the mouse (it stays in the game, which gets all of its motion; Escape releases it)
    if (!state.pointerLocked) capturePointer();
  });
  c.addEventListener('mouseup', (e) => { if (!live()) return; pointer.button(false, winButton(e.button), state.pointerLocked, ...screenPos(e)); e.preventDefault(); });
  c.addEventListener('contextmenu', (e) => e.preventDefault());
  c.addEventListener('wheel', (e) => { if (!live()) return; const [x, y] = state.pointerLocked ? [pointer.vx, pointer.vy] : screenPos(e).map(Math.round); push(EV.WHEEL, e.deltaY < 0 ? 120 : -120, pointer.clampX(x), pointer.clampY(y)); e.preventDefault(); }, { passive: false });
  addEventListener('keydown', (e) => { if ((e.code === 'F12' && !e.shiftKey) || state.benchActive) return; const s = SCAN[e.code] ?? 0; push(EV.KEYDOWN, vkOf(e), s, e.repeat ? 1 : 0); if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) push(EV.CHAR, e.key.charCodeAt(0), 0, 0); if (!(e.ctrlKey && (e.code === 'KeyR' || e.code === 'KeyL'))) e.preventDefault(); });
  addEventListener('keyup', (e) => { if (state.benchActive) return; push(EV.KEYUP, vkOf(e), SCAN[e.code] ?? 0, 0); e.preventDefault(); });
  addEventListener('blur', () => { pointer.left(); if (!state.benchActive) push(EV.FOCUS, 0, 0, 0); });
  addEventListener('focus', () => { if (!state.benchActive) push(EV.FOCUS, 1, 0, 0); });
  document.addEventListener('pointerlockchange', () => {
    const was = state.pointerLocked;
    state.pointerLocked = document.pointerLockElement === c;
    if (state.pointerLocked) { pointer.locked(); state.lockFresh = true; } else pointer.unlocked();
    if (was && !state.pointerLocked && state.status === 'running') toast(TEXT.released, 4000);
    if (shell?.running) shell.setMouse(state.pointerLocked);
    applyCursor();
  });
  document.addEventListener('pointerlockerror', () => { if (state.status === 'running') toast(TEXT.again, 3000); });
  if (!headless) addEventListener('keydown', (e) => { if (e.code === 'F11' || (e.code === 'Enter' && e.altKey)) { e.preventDefault(); e.stopImmediatePropagation(); if (document.fullscreenElement) { document.exitPointerLock(); document.exitFullscreen(); } else enterPlayMode(); } }, true);
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) navigator.keyboard?.unlock?.(); });
}

/**
 * The sound output: an AudioContext and the AudioWorklet playing the game's mix (audio-worklet.js). Created suspended
 * when the page has had no user activation yet (Chrome's autoplay policy, e.g. a game started by the URL): resumed at
 * the player's next gesture (sound.js), with a "click to enable sound" button meanwhile.
 */
async function setupAudio(audioSab, ctlSab) {
  const ctx = new AudioContext({ sampleRate: AUDIO_RATE, latencyHint: 'interactive' });
  state.audio = ctx; state.audioNotRunningSince = ctx.state === 'running' ? null : performance.now();
  resumeOnGesture(ctx, window, () => state.audioStats.noteResume()); // (before the worklet loads: a click meanwhile counts)
  ctx.addEventListener('statechange', () => {
    state.audioStats.noteChange();
    if (ctx.state === 'running') state.audioNotRunningSince = null; else state.audioNotRunningSince ??= performance.now();
    updateSoundHint();
  });
  if ($('soundHint')) $('soundHint').onclick = () => ctx.resume().then(updateSoundHint, () => {}); // (the gesture listeners resume too: this one hides the button at once)
  ctx.addEventListener('error', (e) => { const why = e.error?.message ?? e.message ?? 'output device'; state.audioStats.noteError(`context error: ${why}`); log('warn', `audio output error: ${why}`); }); // (Chrome: the output device failed)
  await ctx.audioWorklet.addModule('/src/host/web/audio-worklet.js');
  const node = new AudioWorkletNode(ctx, 'orthros-output', { outputChannelCount: [2], processorOptions: { audio: audioSab, ctl: ctlSab, frames: AUDIO_RING_FRAMES, write: CTL.AUDIO_WRITE, read: CTL.AUDIO_READ, underruns: CTL.AUDIO_UNDERRUNS } });
  node.onprocessorerror = () => { state.audioStats.noteError('worklet processor error'); log('warn', 'audio unavailable: the AudioWorklet processor failed'); };
  node.connect(ctx.destination);
  state.audioNode = node;
  if (state.audioVoices) node.port.postMessage(state.audioVoices); // (the worker's voice table, if it came first)
  updateSoundHint();
}
/** One stats message's audio part for the telemetry (sound.js AudioStats), with the frames the AudioWorklet played. */
function noteAudio(m) {
  const v = state.audioVoices ? new Int32Array(state.audioVoices.voices) : null;
  const direct = !!v && v[2] === 1, frames = !state.audio ? null : direct ? v[0] : Atomics.load(state.ctl, CTL.AUDIO_READ); // (voice table counter, or the ring's read index)
  const ctx = state.audio, now = performance.now();
  state.audioStats.add(m, ctx, frames, now, direct ? 'voices' : 'ring');
  state.bench?.audio.add(m, ctx, frames, now, direct ? 'voices' : 'ring');
  updateSoundHint();
}
/** The "click to enable sound" button: shown while the context is not running (autoplay policy, system interruption). */
function updateSoundHint() {
  const el = $('soundHint'); if (!el || headless) return;
  const show = soundHintNeeded({ status: state.status, ctxState: state.audio?.state ?? null, notRunningSince: state.audioNotRunningSince ?? null, now: performance.now() });
  el.classList.toggle('hidden', !show);
}

main();
