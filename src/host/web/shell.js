// The frame Orthros puts around every game, whatever runs it (the Windows games' page, the browser ports' pages):
//   - the header over the game (hidden in full screen only): Orthros, the game and its version, the runtime's own
//     indicators, whether the mouse is captured by the game, where the progress is saved, the frame rate, the settings,
//     full screen, back to the games;
//   - the loading screen before the game shows: the game's cover blurred behind, who plays (the Orthros account, or a
//     warning that nothing is saved on an account), the runtime's choices when it has some, the steps of the start;
//   - passing messages, the questions asked to the player, the "sound is off" button.
// The page drives it (createShell(...) and the methods it returns); it never names a game. Styles: player.css.
import { pickLang } from './lang.js';
import { h } from './dom.js';
import { accountState, signIn, onAccountChange, googleSignIn, googleText, GOOGLE_G } from './account.js';

const LOGO = '/src/host/web/orthros_logo.png';
const STRINGS = {
  en: {
    games: '☰ Games', gamesTitle: 'quit the game and return to the game list', fullscreen: '⛶ Full screen', fullscreenTitle: 'full screen: only the game, the mouse captured (hold Esc to leave)',
    settings: 'Settings', perfTitle: 'frames per second, the last minute, the slowest frames', loadingShort: 'loading', paused: 'paused',
    mouseLocked: 'Mouse captured', mouseFree: 'Mouse free', mouseWait: 'Mouse',
    mouseLockedTitle: 'The game has the mouse: Esc releases it', mouseFreeTitle: 'The mouse is free: click the game to give it the mouse', mouseWaitTitle: 'The game is not running yet',
    saveOff: 'Not saved', saveOffTitle: 'You are not signed in: your progress stays only in this browser and can be lost. Click to sign in.',
    saveLocal: 'Saved in this browser', saveLocalTitle: 'This server has no accounts: your progress stays in this browser.',
    saveIdle: 'Account', saveIdleTitle: (u) => `Signed in as ${u}: your progress will be saved on your account`,
    saveSaving: 'Saving…', saveSavingTitle: 'Sending your progress to your account',
    saveSaved: (t) => `Saved ${t}`, saveSavedTitle: (u, t) => `Your progress is saved on the account ${u} (${t})`,
    saveError: 'Not sent', saveErrorTitle: (m) => `Your progress could not be sent to your account (${m}). It is kept here; click to try again.`,
    saveConflict: 'Conflict', saveConflictTitle: 'Your account has another, newer save of this game: click to choose which one to keep.',
    saveTooBig: 'Too large', saveTooBigTitle: 'These saves exceed the 64 MB an account keeps per game: they stay in this browser.',
    saveServer: 'Saved by the world', saveServerTitle: (u) => `Multiplayer: the world's server keeps the character of the account ${u}`,
    whoIn: (u) => [`Signed in as `, h('b', {}, u), ` — your progress is saved on your account.`],
    whoOff: 'You are not signed in: your progress will not be saved on an account. It stays only in this browser and can be lost.',
    whoLocal: 'This server has no accounts: your progress stays in this browser.',
    signIn: 'Sign in', register: 'Create an account', username: 'Username', password: 'Password', go: 'Continue', cancel: 'Cancel', google: 'Continue with Google',
    rules: 'Username: 3 to 32 characters. Password: at least 10 characters. There is no e-mail recovery: write it down.',
    signedIn: (u) => `Signed in as ${u}.`,
    conflictTitle: 'Two different saves', conflictText: (g) => `Your account has a save of ${g} made elsewhere, and this browser has another one that was never sent. Which one do you want to play with? The other one stays in your account's history.`,
    conflictAccount: 'The account\'s save', conflictDevice: 'This browser\'s save',
    quitTitle: (g) => `Quit ${g}?`, quitSaved: 'Your progress is saved on your account.', quitLocal: 'You are not signed in: your progress stays in this browser only.', quit: 'Quit', stay: 'Keep playing',
    quitSaving: 'Saving your progress…', quitFailed: 'Your progress could not be sent to your account. Quit anyway? It stays in this browser.',
    soundOff: 'Sound is off — click to turn it on', log: 'Launch log', ready: 'Ready',
  },
  fr: {
    games: '☰ Jeux', gamesTitle: 'quitter la partie et revenir à la liste des jeux', fullscreen: '⛶ Plein écran', fullscreenTitle: 'plein écran : le jeu seul, la souris capturée (maintiens Échap pour sortir)',
    settings: 'Paramètres', perfTitle: 'images par seconde, la dernière minute, les images les plus lentes', loadingShort: 'chargement', paused: 'en pause',
    mouseLocked: 'Souris capturée', mouseFree: 'Souris libre', mouseWait: 'Souris',
    mouseLockedTitle: 'Le jeu a la souris : Échap la libère', mouseFreeTitle: 'La souris est libre : clique dans le jeu pour la lui donner', mouseWaitTitle: 'Le jeu n’a pas encore démarré',
    saveOff: 'Non sauvegardé', saveOffTitle: 'Tu n’es pas connecté : ta progression reste seulement dans ce navigateur et peut être perdue. Clique pour te connecter.',
    saveLocal: 'Sauvegarde locale', saveLocalTitle: 'Ce serveur n’a pas de comptes : ta progression reste dans ce navigateur.',
    saveIdle: 'Compte', saveIdleTitle: (u) => `Connecté en tant que ${u} : ta progression sera sauvegardée sur ton compte`,
    saveSaving: 'Envoi…', saveSavingTitle: 'Envoi de ta progression sur ton compte',
    saveSaved: (t) => `Sauvegardé ${t}`, saveSavedTitle: (u, t) => `Ta progression est sauvegardée sur le compte ${u} (${t})`,
    saveError: 'Non envoyé', saveErrorTitle: (m) => `Ta progression n’a pas pu être envoyée sur ton compte (${m}). Elle reste ici ; clique pour réessayer.`,
    saveConflict: 'Conflit', saveConflictTitle: 'Ton compte a une autre sauvegarde, plus récente, de ce jeu : clique pour choisir laquelle garder.',
    saveTooBig: 'Trop volumineux', saveTooBigTitle: 'Ces sauvegardes dépassent les 64 Mo qu’un compte garde par jeu : elles restent dans ce navigateur.',
    saveServer: 'Sauvegardé par le monde', saveServerTitle: (u) => `Multijoueur : le serveur du monde garde le personnage du compte ${u}`,
    whoIn: (u) => ['Connecté en tant que ', h('b', {}, u), ' — ta progression est sauvegardée sur ton compte.'],
    whoOff: 'Tu n’es pas connecté : ta progression ne sera pas sauvegardée sur un compte. Elle reste seulement dans ce navigateur et peut être perdue.',
    whoLocal: 'Ce serveur n’a pas de comptes : ta progression reste dans ce navigateur.',
    signIn: 'Se connecter', register: 'Créer un compte', username: 'Identifiant', password: 'Mot de passe', go: 'Continuer', cancel: 'Annuler', google: 'Continuer avec Google',
    rules: 'Identifiant : 3 à 32 caractères. Mot de passe : au moins 10 caractères. Pas de récupération par e-mail : note-le.',
    signedIn: (u) => `Connecté en tant que ${u}.`,
    conflictTitle: 'Deux sauvegardes différentes', conflictText: (g) => `Ton compte a une sauvegarde de ${g} faite ailleurs, et ce navigateur en a une autre jamais envoyée. Avec laquelle veux-tu jouer ? L’autre reste dans l’historique de ton compte.`,
    conflictAccount: 'Celle du compte', conflictDevice: 'Celle de ce navigateur',
    quitTitle: (g) => `Quitter ${g} ?`, quitSaved: 'Ta progression est sauvegardée sur ton compte.', quitLocal: 'Tu n’es pas connecté : ta progression reste seulement dans ce navigateur.', quit: 'Quitter', stay: 'Continuer à jouer',
    quitSaving: 'Sauvegarde de ta progression…', quitFailed: 'Ta progression n’a pas pu être envoyée sur ton compte. Quitter quand même ? Elle reste dans ce navigateur.',
    soundOff: 'Le son est coupé — clique pour l’activer', log: 'Journal de lancement', ready: 'Prêt',
  },
};
const ICON = {
  mouse: '<rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5 4 4 0 0 1 17.5 18H7z"/>',
  alert: '<path d="M12 4l9 16H3L12 4zM12 10v4M12 17v.5"/>',
  check: '<path d="M5 12l4 4 10-10"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  sound: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="m22 9-6 6M16 9l6 6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
};
/**
 * Full screen: the keyboard locked (Keyboard Lock) — Esc and the keys the browser's shortcuts are made of reach the game
 * (Ctrl+W, Ctrl+R, Ctrl+T, Alt+←, F5…: a game holds Ctrl to fire or crouch while letters move); holding Esc leaves the
 * full screen. Tab, Alt, the system key, F4 and F11 stay the system's (Alt+Tab, Alt+F4).
 */
export async function lockKeys() {
  const codes = ['Escape', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'F1', 'F2', 'F3', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F12'];
  for (let i = 0; i < 26; i++) codes.push('Key' + String.fromCharCode(65 + i));
  for (let i = 0; i < 10; i++) codes.push('Digit' + i);
  try { await navigator.keyboard?.lock?.(codes); } catch { /* keyboard lock unavailable: Esc leaves the full screen */ }
}
const svg = (name) => { const s = h('span', { class: 'ic', 'aria-hidden': 'true' }); s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICON[name]}</svg>`; return s; };

/**
 * The frame around a game.
 * @param {{ title: string, version?: string, gameLanguage?: string, cover?: string, subtitle?: string, steps: { k: string, label: string }[],
 *   tips?: string[], extras?: HTMLElement[], headless?: boolean,
 *   onQuit?: () => Promise<boolean|void>, onFullscreen?: () => void, onMouse?: () => void, onPerf?: () => void, onSignedIn?: (user) => void,
 *   saves?: () => import('./cloud-sync.js').CloudSave|null }} o
 */
export function createShell(o) {
  const lang = pickLang(), S = STRINGS[lang] ?? STRINGS.en;
  document.documentElement.lang = lang;
  const shell = { lang, S, account: null, accounts: null, running: false };

  // ---------------------------------------------------------------- the header
  const fpsEl = h('span', { class: 'fps' }, '–'), sub = h('span', { class: 'sub' }), graph = h('canvas', { width: 96, height: 24 });
  const perf = h('div', { class: 'perf', id: 'tbPerf', title: S.perfTitle }, fpsEl, h('span', { class: 'unit' }, 'fps'), graph, sub);
  if (o.onPerf) perf.onclick = o.onPerf; else perf.classList.add('still');
  const mouseText = h('span'), mouse = h('button', { type: 'button', class: 'pill mouse', id: 'tbMouse' }, svg('mouse'), mouseText);
  const saveText = h('span'), save = h('button', { type: 'button', class: 'pill save', id: 'tbSave' }, svg('cloud'), saveText);
  const settings = h('button', { type: 'button', class: 'icon', id: 'tbSettings', title: S.settings, 'aria-label': S.settings, onclick: () => window.orthrosData?.open?.('cloud') }, svg('gear'));
  const full = h('button', { type: 'button', id: 'tbFull', title: S.fullscreenTitle }, S.fullscreen);
  const games = h('button', { type: 'button', id: 'tbGames', class: 'quiet', title: S.gamesTitle }, S.games);
  const gameEl = h('span', { class: 'game', id: 'tbGame' }, o.title), tagEl = h('span', { class: 'tag' });
  const extras = h('div', { class: 'extras' }, ...(o.extras ?? []));
  const bar = h('div', { id: 'topbar' },
    h('div', { class: 'brand' }, h('img', { src: LOGO, alt: '' }), h('span', { class: 'name' }, 'Orthros'), h('span', { class: 'sep' }), gameEl, tagEl),
    h('div', { class: 'spacer' }), extras, mouse, save, perf, settings, full, games);
  shell.bar = bar; shell.extras = extras;
  shell.setTitle = (title, version = o.version, language = o.gameLanguage) => {
    gameEl.textContent = title; document.title = `${title} · Orthros`;
    tagEl.textContent = [version, language?.toUpperCase()].filter(Boolean).join(' · ');
    tagEl.hidden = !tagEl.textContent;
  };
  shell.setTitle(o.title);

  // ---------------------------------------------------------------- the loading screen
  const stepsEl = h('ul', {}, o.steps.map((s) => h('li', { 'data-k': s.k }, h('span', { class: 'ic' }), h('span', {}, s.label), h('span', { class: 'v' }))));
  const fill = h('div', { class: 'fill' }), pctEl = h('span', { class: 'pct' }, '0%'), phaseEl = h('span', { class: 'phase', id: 'status', role: 'status' });
  const tipEl = h('div', { class: 'tip', id: 'tip' }), logEl = h('pre', { id: 'log' }), logBox = h('details', { class: 'log' }, h('summary', {}, S.log), logEl);
  const titleEl = h('div', { class: 'title', id: 'title' }, o.title), subEl = h('div', { class: 'subtitle', id: 'subtitle' }, o.subtitle ?? '');
  const who = h('div', { class: 'who' }), choices = h('div', { class: 'choices' });
  const progress = h('div', { class: 'progress' }, h('div', { class: 'bar' }, fill), h('div', { class: 'row' }, phaseEl, pctEl), stepsEl);
  const loaderBg = h('div', { class: 'bg' });
  const loader = h('div', { id: 'loader' }, loaderBg, h('div', { class: 'box' },
    h('div', { class: 'head' }, h('img', { src: LOGO, alt: '' }), h('div', {}, titleEl, subEl)), who, choices, progress, tipEl, logBox));
  if (o.cover) loaderBg.style.backgroundImage = `url(${o.cover})`;
  shell.loader = loader; shell.choices = choices; shell.logEl = logEl;
  let pct = 0, tipTimer = null;
  const tips = o.tips ?? [];
  if (tips.length) {
    let i = Math.floor(Math.random() * tips.length); tipEl.textContent = tips[i];
    tipTimer = setInterval(() => { i = (i + 1) % tips.length; tipEl.textContent = tips[i]; }, 9000);
  } else tipEl.hidden = true;
  /** One step of the start: '' (to come), 'active', 'done', 'skip'; its figure. */
  shell.step = (k, state, value = '') => { const li = stepsEl.querySelector(`li[data-k="${k}"]`); if (!li) return; li.className = state; li.querySelector('.v').textContent = value; };
  /** The bar (never going back) and the line under it. */
  shell.progress = (value, text) => {
    if (value != null) { pct = Math.max(pct, Math.min(99, Math.floor(value))); fill.style.width = pct + '%'; pctEl.textContent = pct + '%'; }
    if (text != null) phaseEl.textContent = text;
  };
  shell.phase = (text, error = false) => { phaseEl.textContent = text; phaseEl.classList.toggle('error', error); if (loader.classList.contains('hidden') && text) shell.toast(text, error ? 9000 : 5000); };
  /** Progress shown or not (the runtime's choices first, as the browser ports' modes). */
  shell.showProgress = (on) => { progress.hidden = !on; };
  shell.hideLoader = (now = false) => {
    if (loader.classList.contains('hidden')) return;
    clearInterval(tipTimer);
    fill.style.width = '100%'; pctEl.textContent = '100%'; phaseEl.textContent = S.ready;
    if (now) { loader.classList.add('hidden'); return; }
    setTimeout(() => { loader.classList.add('gone'); setTimeout(() => { loader.classList.add('hidden'); o.onLoaderHidden?.(); }, 600); }, 250);
  };
  shell.showLoader = () => { loader.classList.remove('hidden', 'gone'); };
  shell.log = (line) => { logEl.textContent = (logEl.textContent + line + '\n').slice(-20000); };

  // ---------------------------------------------------------------- who plays
  function renderWho() {
    who.replaceChildren();
    if (shell.accounts === null) return;
    if (!shell.accounts) { who.className = 'who local'; who.append(svg('cloud'), h('p', {}, S.whoLocal)); return; }
    if (shell.account) { who.className = 'who in'; who.append(svg('user'), h('p', {}, ...S.whoIn(shell.account.username))); return; }
    who.className = 'who off';
    const form = h('form', { class: 'signin', hidden: true });
    const user = h('input', { name: 'username', required: true, minlength: 3, maxlength: 32, autocomplete: 'username', 'aria-label': S.username, placeholder: S.username });
    const pass = h('input', { name: 'password', type: 'password', required: true, maxlength: 128, autocomplete: 'current-password', 'aria-label': S.password, placeholder: S.password });
    const err = h('p', { class: 'err', role: 'alert' }), submit = h('button', { type: 'submit', class: 'primary' }, S.go);
    let mode = 'login';
    form.append(user, pass, submit, h('button', { type: 'button', class: 'ghost', onclick: () => { form.hidden = true; } }, S.cancel), err, h('small', {}, S.rules));
    const open = (m) => { mode = m; form.hidden = false; pass.autocomplete = m === 'register' ? 'new-password' : 'current-password'; pass.minLength = m === 'register' ? 10 : 0; submit.textContent = m === 'register' ? S.register : S.signIn; user.focus(); };
    form.onsubmit = async (e) => {
      e.preventDefault(); e.stopPropagation(); submit.disabled = true; err.textContent = '';
      try { await signIn(mode, user.value, pass.value, lang); } catch (x) { err.textContent = x.message; } finally { submit.disabled = false; }
    };
    for (const type of ['keydown', 'keyup', 'keypress']) form.addEventListener(type, (e) => e.stopPropagation()); // (the game's key handlers never see what is typed here)
    // (Google: a small window, the page stays — signIn's listeners run when it says so)
    const gErr = h('p', { class: 'gerr', role: 'alert' }), g = h('span', { class: 'g', 'aria-hidden': 'true' }); g.innerHTML = GOOGLE_G;
    const google = shell.google ? h('button', { type: 'button', class: 'google', onclick: async () => { gErr.textContent = ''; const r = await googleSignIn(lang); if (!r.ok) gErr.textContent = googleText(r, lang); } }, g, S.google) : null;
    who.append(svg('alert'), h('div', {}, h('p', {}, S.whoOff), h('div', { class: 'acts' },
      h('button', { type: 'button', class: 'primary', onclick: () => open('login') }, S.signIn),
      h('button', { type: 'button', onclick: () => open('register') }, S.register), google), gErr, form));
    shell.openSignIn = open;
  }
  onAccountChange(({ user }) => {
    const was = shell.account?.username; shell.account = user; renderWho(); renderSave();
    if (user && user.username !== was) { shell.toast(S.signedIn(user.username), 4000); o.onSignedIn?.(user); }
  });
  /** Who plays, asked of the server: { accounts, user }. */
  shell.ready = accountState().then((st) => { shell.accounts = st.accounts; shell.google = st.google; shell.account = st.user; renderWho(); renderSave(); return st; });

  // ---------------------------------------------------------------- the mouse
  /** true: the game has the mouse (pointer lock), false: free, null: no game yet. */
  shell.setMouse = (locked) => {
    mouse.classList.toggle('on', locked === true); mouse.classList.toggle('wait', locked == null);
    mouse.querySelector('.ic').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICON[locked ? 'lock' : 'mouse']}</svg>`;
    mouseText.textContent = locked == null ? S.mouseWait : locked ? S.mouseLocked : S.mouseFree;
    mouse.title = locked == null ? S.mouseWaitTitle : locked ? S.mouseLockedTitle : S.mouseFreeTitle;
    mouse.setAttribute('aria-label', mouse.title);
  };
  shell.setMouse(null);
  mouse.onclick = () => o.onMouse?.();
  /** Follows the pointer lock of `doc` (the page's, or a frame's of the same origin). */
  shell.watchPointer = (doc = document) => {
    const upd = () => shell.setMouse(shell.running ? !!doc.pointerLockElement : null);
    doc.addEventListener('pointerlockchange', upd); upd();
    return upd;
  };

  // ---------------------------------------------------------------- the saves
  let saveState = { state: 'off' };
  const clock = (t) => new Date(t).toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' });
  function renderSave() {
    const s = saveState, u = shell.account?.username ?? '';
    let cls = '', text = '', title = '', icon = 'cloud';
    if (shell.accounts === false) { text = S.saveLocal; title = S.saveLocalTitle; }
    else if (!shell.account) { cls = 'warn'; icon = 'alert'; text = S.saveOff; title = S.saveOffTitle; }
    else if (s.state === 'saving') { cls = 'busy'; text = S.saveSaving; title = S.saveSavingTitle; }
    else if (s.state === 'saved') { cls = 'ok'; icon = 'check'; text = S.saveSaved(clock(s.at)); title = S.saveSavedTitle(u, clock(s.at)); }
    else if (s.state === 'error') { cls = 'bad'; icon = 'alert'; text = S.saveError; title = S.saveErrorTitle(s.message ?? '?'); }
    else if (s.state === 'conflict') { cls = 'bad'; icon = 'alert'; text = S.saveConflict; title = S.saveConflictTitle; }
    else if (s.state === 'toobig') { cls = 'bad'; icon = 'alert'; text = S.saveTooBig; title = S.saveTooBigTitle; }
    else if (s.state === 'server') { cls = 'ok'; icon = 'check'; text = S.saveServer; title = S.saveServerTitle(u); }
    else { text = `${S.saveIdle} · ${u}`; title = S.saveIdleTitle(u); }
    save.className = 'pill save ' + cls; save.title = title; save.setAttribute('aria-label', title); saveText.textContent = text;
    save.querySelector('.ic').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${ICON[icon]}</svg>`;
  }
  /** A CloudSave status (cloud-sync.js), or the runtime's own: { state: off|idle|saving|saved|error|conflict|toobig, ... }. */
  shell.setSave = (status) => { saveState = status ?? { state: 'off' }; renderSave(); };
  save.onclick = async () => {
    const cloud = o.saves?.();
    if (!shell.account && shell.accounts) { shell.showLoaderSignIn?.(); return; }
    if (saveState.state === 'conflict' && cloud) { await shell.resolveConflict(cloud); return; }
    if (saveState.state === 'error' && cloud) cloud.push();
    else window.orthrosData?.open?.('cloud');
  };
  /** Not signed in, from the header: the account window (the loading screen's form is gone with it). */
  shell.showLoaderSignIn = () => { if (window.orthrosData?.open) window.orthrosData.open('account'); else if (!loader.classList.contains('hidden')) shell.openSignIn?.('login'); };
  /** The player chooses between the account's save and this browser's: the CloudSave settles it. */
  shell.resolveConflict = async (cloud) => {
    const choice = await shell.ask({ title: S.conflictTitle, text: S.conflictText(o.title), buttons: [{ value: 'account', label: S.conflictAccount, primary: true }, { value: 'device', label: S.conflictDevice }] });
    if (choice) await cloud.resolve(choice);
    return choice;
  };

  // ---------------------------------------------------------------- the frame rate
  /** samples: [{ fps, p99, max }] every ~0.5 s (the last two shown, the last minute drawn); mode: 'loading', 'paused' or 'running'. */
  shell.setFps = (samples, mode = 'running', extra = '') => {
    const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
    if (mode === 'loading') { fpsEl.textContent = '…'; fpsEl.className = 'fps'; sub.textContent = S.loadingShort + (extra ? '\n' + extra : ''); }
    else if (mode === 'paused') { fpsEl.textContent = '❚❚'; fpsEl.className = 'fps'; sub.textContent = S.paused; }
    else {
      const last = samples.slice(-2), f = last.reduce((a, s) => a + s.fps, 0) / Math.max(1, last.length);
      fpsEl.textContent = f.toFixed(0); fpsEl.className = 'fps ' + (f >= 29.5 ? 'good' : f >= 20 ? 'warn' : 'bad');
      sub.textContent = `p99 ${ms(Math.max(0, ...last.map((s) => s.p99 ?? 0)))}\nmax ${ms(Math.max(0, ...last.map((s) => s.max ?? 0)))}`;
    }
    drawGraph(graph, mode === 'running' ? samples : []);
  };
  shell.drawGraph = drawGraph;

  // ---------------------------------------------------------------- passing messages, questions
  const toastEl = h('div', { id: 'toast', class: 'hidden' });
  let toastTimer = null;
  shell.toast = (text, ms = 5000) => {
    if (o.headless) return;
    toastEl.textContent = text; toastEl.classList.remove('hidden'); toastEl.style.opacity = '1';
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; setTimeout(() => toastEl.classList.add('hidden'), 700); }, ms);
  };
  const askEl = h('div', { id: 'ask', class: 'hidden', role: 'dialog', 'aria-modal': 'true' });
  /** A question: resolves to the value of the button chosen, null when dismissed (Escape, outside). */
  shell.ask = ({ title, text, buttons }) => new Promise((resolve) => {
    if (document.pointerLockElement) document.exitPointerLock();
    const done = (v) => { askEl.classList.add('hidden'); askEl.replaceChildren(); removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); done(null); } else if (!askEl.contains(e.target)) { e.stopImmediatePropagation(); } };
    addEventListener('keydown', onKey, true);
    const btns = buttons.map((b) => h('button', { type: 'button', class: b.primary ? 'primary' : b.danger ? 'danger' : '', onclick: () => done(b.value) }, b.label));
    askEl.replaceChildren(h('div', { class: 'card' }, h('h3', {}, title), text ? h('p', {}, text) : null, h('div', { class: 'acts' }, btns)));
    askEl.onclick = (e) => { if (e.target === askEl) done(null); };
    for (const type of ['mousedown', 'mouseup', 'click', 'keyup']) askEl.addEventListener(type, (e) => e.stopPropagation());
    askEl.classList.remove('hidden'); (btns.find((b) => b.classList.contains('primary')) ?? btns[0])?.focus();
  });
  const soundEl = h('button', { id: 'soundHint', type: 'button', class: 'hidden' }, svg('sound'), h('span', {}, S.soundOff));
  shell.sound = soundEl;

  // ---------------------------------------------------------------- full screen, back to the games
  full.onclick = async (e) => {
    e.preventDefault();
    if (o.onFullscreen) return o.onFullscreen();
    try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { return; }
    await lockKeys();
  };
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) navigator.keyboard?.unlock?.(); });
  let quitting = false;
  /** Back to the game list: asked first while a game runs; the runtime saves (onQuit) before the page goes. */
  shell.quit = async () => {
    if (quitting) return;
    if (shell.running && !o.headless) {
      const signedIn = !!shell.account;
      const ok = await shell.ask({ title: S.quitTitle(o.title), text: signedIn ? S.quitSaved : S.quitLocal, buttons: [{ value: true, label: S.quit, primary: true }, { value: false, label: S.stay }] });
      if (!ok) return;
    }
    quitting = true; games.disabled = true;
    try {
      shell.toast(S.quitSaving, 20000);
      const saved = await o.onQuit?.();
      if (saved === false && shell.account && !(await shell.ask({ title: S.quitTitle(o.title), text: S.quitFailed, buttons: [{ value: true, label: S.quit, danger: true }, { value: false, label: S.stay }] }))) { quitting = false; games.disabled = false; return; }
    } catch (e) { console.error(e); }
    location.href = '/?menu';
  };
  games.onclick = (e) => { e.preventDefault(); shell.quit(); };
  // (out of full screen the browser keeps its shortcuts: a page left with Ctrl or ⌘ held while the game runs — Ctrl+W,
  // Ctrl+R in the middle of a fight — asks first; watchKeys(doc): a frame's document the game's keys go to)
  let held = false;
  shell.watchKeys = (doc) => {
    const note = (e) => { held = e.ctrlKey || e.metaKey; };
    doc.addEventListener('keydown', note, true); doc.addEventListener('keyup', note, true);
    doc.defaultView?.addEventListener('blur', () => { held = false; });
  };
  shell.watchKeys(document);
  addEventListener('beforeunload', (e) => { if (held && shell.running && !quitting && !o.headless) { e.preventDefault(); e.returnValue = ''; } });
  // (the header and its windows keep their clicks: the game under them never sees them)
  for (const type of ['mousedown', 'mouseup', 'click', 'contextmenu', 'wheel']) bar.addEventListener(type, (e) => e.stopPropagation());

  if (!o.headless) document.body.append(loader, bar, toastEl, askEl, soundEl);
  else document.body.classList.add('nobar');
  return shell;
}

/** The frame rate of the last minute (120 samples) against 30 fps, the frames over 50 ms marked in red above. */
export function drawGraph(cv, samples) {
  const g = cv.getContext('2d'), w = cv.width, ht = cv.height, top = 60, span = 120;
  const y = (v) => ht - 1 - Math.min(v, top) / top * (ht - 2);
  g.clearRect(0, 0, w, ht); g.fillStyle = 'rgba(255,255,255,0.04)'; g.fillRect(0, 0, w, ht);
  g.strokeStyle = 'rgba(255,255,255,0.25)'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(0, y(30)); g.lineTo(w, y(30)); g.stroke(); g.setLineDash([]);
  const shown = samples.slice(-span), x0 = w - shown.length * (w / span);
  g.strokeStyle = '#8fd18f'; g.beginPath();
  shown.forEach((p, i) => { const x = x0 + i * (w / span); if (i) g.lineTo(x, y(p.fps)); else g.moveTo(x, y(p.fps)); });
  g.stroke();
  g.fillStyle = '#ff6b6b'; shown.forEach((p, i) => { if ((p.max ?? 0) > 50) g.fillRect(x0 + i * (w / span), 0, 2, 4); });
}
