// The page of an OpenMW browser port (src/host/openmw.js, docs/openmw.md), /ports/openmw/<manifest>/: the pinned
// OpenMW-Web engine's own page in a frame (app/), under the frame every Orthros game has (/src/host/web/shell.js):
// the header (the mouse, the saves, the frame rate, full screen, back to the games) and the loading screen, where the
// player chooses the game's language and plays alone or with friends. Alone, the saves go to the player's Orthros
// account (cloud.js, in the engine's page); with friends, the world's server keeps the character of the account.
// The engine's page tells its frames and the mouse (frame-meter.js) and its saves (cloud.js) by messages.
import { pickLang } from '../../host/web/lang.js';
import { createShell } from '../../host/web/shell.js';
import { endonym } from '../../host/web/lang.js';

const STRINGS = {
  en: {
    subtitle: 'the original game, on the OpenMW engine in your browser',
    steps: { engine: 'Starting the engine', world: 'Opening the world' },
    tips: [
      'Signed in to Orthros, your solo saves follow you on your account, and the multiplayer worlds are open.',
      'Multiplayer: create a character, open your world in Party mode and add your friends; the campaign advances in its host\'s world.',
      'Full screen (button above) gives the game the whole screen; hold Esc to leave it.',
      'The first launch downloads the game into this browser: the next ones start from its own copy.',
    ],
    language: 'Game language', solo: 'Play solo', multi: 'Play with friends',
    multiNeed: 'Multiplayer needs an Orthros account: sign in above, then play with friends.',
    notInstalled: 'The game or engine files are not installed on this server yet.', missing: 'files not installed',
    engine: 'Engine', license: 'GPLv3', experimental: 'Multiplayer is experimental.',
    preparing: 'Preparing the game…', launching: 'Starting the engine…', world: 'Opening the world…',
    download: (got, total, rate) => `Downloading the engine · ${got} / ${total} MB${rate ? ` · ${rate} MB/s` : ''}`,
    reading: 'Reading the game data… up to a minute the first time',
    capture: 'Click in the game to give it the mouse · Esc releases it',
    saveServer: 'the world\'s server keeps your character on your account',
    failed: 'The game could not start: ',
  },
  fr: {
    subtitle: 'le jeu d’origine, sur le moteur OpenMW dans ton navigateur',
    steps: { engine: 'Démarrage du moteur', world: 'Ouverture du monde' },
    tips: [
      'Connecté à Orthros, tes sauvegardes solo te suivent sur ton compte, et les mondes multijoueurs sont ouverts.',
      'Multijoueur : crée un personnage, ouvre ton monde en mode Party et ajoute tes amis ; la campagne avance dans le monde de son hôte.',
      'Le plein écran (bouton en haut) donne tout l’écran au jeu ; maintiens Échap pour en sortir.',
      'Le premier lancement télécharge le jeu dans ce navigateur : les suivants partent de sa copie.',
    ],
    language: 'Langue du jeu', solo: 'Jouer en solo', multi: 'Jouer avec mes amis',
    multiNeed: 'Le multijoueur demande un compte Orthros : connecte-toi ci-dessus, puis joue avec tes amis.',
    notInstalled: 'Les fichiers du jeu ou du moteur ne sont pas encore installés sur ce serveur.', missing: 'fichiers non installés',
    engine: 'Moteur', license: 'GPLv3', experimental: 'Le multijoueur est expérimental.',
    preparing: 'Préparation de la partie…', launching: 'Démarrage du moteur…', world: 'Ouverture du monde…',
    download: (got, total, rate) => `Téléchargement du moteur · ${got} / ${total} Mo${rate ? ` · ${rate} Mo/s` : ''}`,
    reading: 'Lecture des données du jeu… jusqu’à une minute la première fois',
    capture: 'Clique dans le jeu pour lui donner la souris · Échap la libère',
    saveServer: 'le serveur du monde garde ton personnage sur ton compte',
    failed: 'Le jeu n’a pas pu démarrer : ',
  },
};
const lang = pickLang(), S = STRINGS[lang] ?? STRINGS.en;
const id = decodeURIComponent(location.pathname.split('/')[3]);
const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const frame = $('#game');
let shell = null, man = null, mode = null, samples = [], drawn = false;
const session = window.portSession = { state: 'loading', mode: null };

// Returning players must choose a character in the upstream launcher before the engine can
// draw. Keep that page clickable; restore the common loading screen when the engine loads.
frame.addEventListener('load', () => {
  try { shell?.watchKeys(frame.contentDocument); } catch { /* not the engine's page */ }
  if (!shell || mode !== 'multi') return;
  let pathname;
  try { pathname = frame.contentWindow.location.pathname; } catch { return; }
  const base = `/ports/openmw/${encodeURIComponent(id)}/app/`;
  if (['join', 'launcher.html', 'play'].some((name) => pathname === base + name)) shell.hideLoader(true);
  else if (pathname === base + 'index.html' && !drawn) {
    shell.showLoader(); shell.progress(20, S.launching);
  }
});

async function api(route, method = 'GET', body) {
  const r = await fetch(route, { method, cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`); return data;
}

/** The engine's page in the frame: alone (the hosted game, its saves on the account) or with friends (a world's ticket). */
async function enter(chosen) {
  if (session.state !== 'ready') return;
  if (chosen === 'multi' && !shell.account) { shell.openSignIn?.('login'); shell.phase(S.multiNeed); pendingMulti = true; return; }
  session.state = 'starting'; mode = session.mode = chosen;
  shell.choices.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  shell.showProgress(true); shell.step('engine', 'active'); shell.step('world', ''); shell.progress(8, S.preparing);
  try {
    let src;
    if (chosen === 'multi') {
      const data = await api(`/api/openmw/${encodeURIComponent(id)}/launch`, 'POST');
      src = `app/join#${new URLSearchParams({ mpticket: data.ticket, mpaccount: data.account, mplocker: data.locker })}`;
      shell.setSave({ state: 'server' });
    } else {
      src = man.openmw.example ? `app/index.html?nomw${man.openmw.startCell ? '&start=' + encodeURIComponent(man.openmw.startCell) : ''}` : 'app/index.html?src=hosted';
      if (shell.account) shell.setSave({ state: 'idle' });
    }
    shell.progress(20, S.launching);
    frame.src = src; frame.hidden = false;
    session.state = 'running';
  } catch (e) { session.state = 'ready'; shell.phase(S.failed + e.message, true); shell.choices.querySelectorAll('button').forEach((b) => { b.disabled = false; }); }
}
let pendingMulti = false;

/** The game's language: its versions in other languages are other installations, reached by their own page. */
function languageChoice(entry) {
  const urls = man.languageLaunchUrls ?? {}, codes = [...new Set(['fr', 'en', ...(man.languages ?? [])])];
  const current = man.contentLanguages?.[0] ?? man.languages?.[0] ?? 'en';
  if (codes.length < 2 && !urls[current]) return null;
  const seg = document.createElement('div'); seg.className = 'seg'; seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', S.language);
  for (const code of codes) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = endonym(code); b.setAttribute('role', 'radio');
    const there = urls[code], on = code === current;
    b.className = on ? 'on' : ''; b.setAttribute('aria-checked', String(on)); b.disabled = !there && !on; if (b.disabled) b.title = S.missing;
    b.onclick = () => {
      if (on || !there) return;
      try { localStorage.setItem(`orthros.gameLanguage.${man.gameId ?? id}`, code); } catch { /* optional */ }
      const target = new URL(there, location.origin); target.searchParams.set('gameLang', code); location.href = target.href;
    };
    seg.append(b);
  }
  const row = document.createElement('div'); row.className = 'lang';
  row.append(Object.assign(document.createElement('span'), { textContent: S.language }), seg);
  return row;
}

// ---------------------------------------------------------------- what the engine's page tells (frame-meter.js, cloud.js)
/** The engine's loading status on the loading screen: its package download (received / size, rate), then the read. */
const mb = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }), seen = [];
function status(text) {
  const got = /^Downloading data\.\.\. \((\d+)\/(\d+)\)/.exec(text);
  if (got) {
    const bytes = Number(got[1]), size = Number(got[2]), now = performance.now();
    seen.push([now, bytes]); while (seen.length > 2 && seen[0][0] < now - 3000) seen.shift();
    const rate = now - seen[0][0] > 500 ? (bytes - seen[0][1]) / (now - seen[0][0]) * 1000 / 1048576 : 0;
    // (at its end the engine reads the game data at once, the page frozen until then: said now, while it can be)
    if (bytes >= size) shell.progress(62, S.reading);
    else shell.progress(20 + 40 * bytes / size, S.download(mb.format(bytes / 1048576), mb.format(size / 1048576), rate > 0 ? mb.format(rate) : ''));
  } else if (/^Running/.test(text)) shell.progress(62, S.reading);
}

addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
  const m = event.data ?? {};
  if (m.type === 'orthros-frames') {
    samples.push({ fps: m.fps, max: m.max, p99: m.p99 }); if (samples.length > 120) samples.shift();
    if (m.fps > 0 && !drawn) { drawn = true; shell.step('engine', 'done'); shell.step('world', 'active'); shell.progress(70, S.world); setTimeout(() => { shell.step('world', 'done'); shell.hideLoader(); shell.running = true; shell.setMouse(false); shell.toast(S.capture, 6000); frame.focus(); }, 1500); }
    shell.setFps(samples, !drawn ? 'loading' : document.hidden ? 'paused' : 'running');
  } else if (m.type === 'orthros-status') { if (!drawn) status(String(m.text ?? '')); }
  else if (m.type === 'orthros-pointer') { if (shell.running) shell.setMouse(!!m.locked); }
  else if (m.type === 'orthros-save-status') shell.setSave(m.state ? { state: m.state, at: Date.now(), message: m.message } : { state: m.error ? 'error' : 'saved', at: Date.now(), message: m.message });
});

try {
  const [mr, lr] = await Promise.all([fetch(`/api/manifest/${encodeURIComponent(id)}`), fetch('/api/manifests')]);
  if (!mr.ok || !lr.ok) throw new Error('version');
  man = await mr.json();
  const entry = (await lr.json()).find((m) => m.name === id);
  const language = man.contentLanguages?.[0] ?? man.languages?.[0] ?? null;
  shell = createShell({
    title: man.name, version: man.version, gameLanguage: language, cover: `/api/cover/${encodeURIComponent(id)}`, subtitle: S.subtitle,
    steps: Object.entries(S.steps).map(([k, label]) => ({ k, label })), tips: S.tips,
    onMouse: () => { frame.focus(); frame.contentWindow?.postMessage({ type: 'orthros-capture' }, location.origin); shell.toast(S.capture, 4000); },
    onQuit: () => flush(), onSignedIn: () => { if (pendingMulti) { pendingMulti = false; enter('multi'); } else if (session.state === 'ready') render(entry); },
    saves: () => null,
  });
  // (the save indicator: the account's cloud copy is the engine page's — a conflict is settled there, in the game)
  shell.showProgress(false);
  await shell.ready;
  render(entry);
  session.state = entry?.available ? 'ready' : 'missing';
  if (!entry?.available) shell.phase(S.notInstalled, true);
  else if (params.get('mode') === 'multi' || params.get('mode') === 'solo') enter(params.get('mode'));
} catch (e) { if (shell) shell.phase(S.failed + e.message, true); else document.body.textContent = S.failed + e.message; }

/** The loading screen's choices: the game's language, then alone or with friends; the engine's licence. */
function render(entry) {
  const box = shell.choices; box.replaceChildren();
  const lang = languageChoice(entry); if (lang) box.append(lang);
  const acts = document.createElement('div'); acts.className = 'acts';
  const solo = Object.assign(document.createElement('button'), { type: 'button', id: 'solo', className: 'primary', textContent: S.solo, disabled: !entry?.available, onclick: () => enter('solo') });
  acts.append(solo);
  if (man.openmw.multiplayer) acts.append(Object.assign(document.createElement('button'), { type: 'button', id: 'multi', textContent: S.multi, disabled: !entry?.available || shell.accounts === false, onclick: () => enter('multi') }));
  box.append(acts);
  const note = document.createElement('p'); note.className = 'note';
  note.innerHTML = `${S.engine} <a href="https://github.com/Virtastic/openmw-web/tree/v1.5.3" target="_blank" rel="noopener">OpenMW-Web · ${S.license}</a>.${man.openmw.multiplayer ? ' ' + S.experimental : ''}`;
  box.append(note);
  solo.focus();
}

/** Back to the games: the engine's page sends what is not on the account yet (cloud.js), 15 s at most. */
function flush() {
  if (session.state !== 'running' || mode !== 'solo' || !shell.account || !frame.contentWindow) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (ok) => { removeEventListener('message', on); clearTimeout(t); resolve(ok); };
    const on = (e) => { if (e.source === frame.contentWindow && e.data?.type === 'orthros-flushed') done(!!e.data.ok); };
    const t = setTimeout(() => done(false), 15000);
    addEventListener('message', on);
    frame.contentWindow.postMessage({ type: 'orthros-flush' }, location.origin);
  });
}
