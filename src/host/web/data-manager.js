// "My data": what the browser keeps for the visitor — the saves and settings of each game, the game files already
// downloaded — and the optional account that copies the saves online. A window over the page (opened from the home
// screen and from the in-game header); it follows the page language.
import { archiveProfile, download, hashBytes, parseArchive, removeCache, removeProfile, restoreProfile, scanStorage } from './data-store.js';
import { pickLang } from './lang.js';
import { h } from './dom.js';

// ---------------------------------------------------------------- text
const TEXT = {
  fr: {
    title: 'Mes données', subtitle: 'Sauvegardes et stockage', close: 'Fermer',
    tabDevice: 'Cet appareil', tabCloud: 'En ligne', tabAccount: 'Compte',
    hintUsed: (b) => `${b} utilisés`, hintReading: 'Lecture…', hintCloud: 'Synchronisation', hintCloudOff: 'Compte requis', hintAccount: 'Facultatif',
    sideNote: 'Jouer ne demande aucun compte. Vos parties restent dans ce navigateur tant que vous ne les envoyez pas.',
    // this device
    deviceTitle: 'Sauvegardes et cache des jeux',
    deviceLead: 'Vos parties et réglages, ainsi que les fichiers de jeu déjà téléchargés, sont rangés dans ce navigateur. Exportez vos sauvegardes pour les garder ailleurs.',
    used: 'Espace utilisé', ofQuota: (b) => `sur ${b} disponibles`, quotaUnknown: 'Quota indisponible',
    protection: 'Protection du stockage', protectionOn: 'Activée', protectionOnText: 'Le navigateur évitera d’effacer ces données.',
    protectionOff: 'À activer', protectionOffText: 'Sinon, le navigateur peut les effacer s’il manque de place.', protectionAsk: 'Activer la protection',
    protectionWork: 'Demande de protection', protectionDone: 'Protection activée.', protectionDenied: 'Le navigateur a refusé la demande.',
    games: 'Vos jeux', saves: 'Sauvegardes', cache: 'Cache', cacheHelp: 'Fichiers du jeu déjà téléchargés : ils peuvent l’être de nouveau.',
    export: 'Exporter', import: 'Importer', clean: 'Nettoyer',
    cleanCache: 'Vider le cache', cleanCacheText: 'Les fichiers du jeu seront téléchargés de nouveau au prochain lancement.',
    cleanSaves: 'Effacer les sauvegardes', cleanSavesText: 'Supprime définitivement les parties et réglages de cet appareil.',
    playing: 'Jeu en cours : l’import et le nettoyage seront possibles après l’avoir quitté.',
    noData: (n) => `Jeux sans données sur cet appareil (${n})`, noGames: 'Aucun jeu', noGamesText: 'Les jeux apparaîtront ici dès que le serveur les proposera.',
    asides: 'Copies de secours', asidesText: 'Gardées automatiquement avant une restauration. Supprimez-les quand vous n’en avez plus besoin.',
    delete: 'Supprimer', more: 'Plus d’options',
    // online
    cloudTitle: 'Sauvegarde en ligne',
    cloudLead: 'Copiez vos sauvegardes sur votre compte pour les retrouver sur un autre appareil. Les fichiers des jeux ne sont jamais envoyés.',
    cloudOffTitle: 'Retrouvez vos parties partout', cloudOffText: 'Connectez-vous pour garder une copie de vos sauvegardes en ligne. C’est facultatif : le jeu fonctionne très bien sans.',
    signIn: 'Se connecter ou créer un compte', accountsOff: 'Les comptes ne sont pas activés sur ce serveur.',
    signedAs: (n) => `Connecté : ${n}`, keeps: 'Jusqu’à 20 versions conservées par jeu.', syncAll: 'Synchroniser maintenant',
    online: 'En ligne', version: (v) => `version ${v}`, noCopy: 'Pas encore de copie en ligne',
    send: 'Envoyer', restore: 'Restaurer', downloadBtn: 'Télécharger', history: 'Historique', deleteOnline: 'Effacer en ligne',
    noSaves: 'Aucune sauvegarde pour le moment', noSavesText: 'Lancez un jeu, puis revenez ici pour créer sa première copie en ligne.',
    conflictNote: 'Si cet appareil et le serveur diffèrent, rien n’est écrasé automatiquement : vous choisissez la version à garder.',
    // account
    accountTitle: 'Votre compte', accountLead: 'Facultatif. Il sert uniquement à garder vos sauvegardes en ligne : vous pouvez jouer sans.',
    signedIn: 'Connecté', signOut: 'Se déconnecter', signOutDone: 'Déconnecté. Les sauvegardes de cet appareil restent ici.',
    changePassword: 'Changer le mot de passe', oldPassword: 'Mot de passe actuel', newPassword: 'Nouveau mot de passe', changePasswordBtn: 'Modifier le mot de passe', passwordChanged: 'Mot de passe modifié.',
    deleteAccount: 'Supprimer le compte', deleteAccountText: 'Efface toutes les copies en ligne. Les données de cet appareil restent intactes.', deleteAccountBtn: 'Supprimer mon compte',
    login: 'Se connecter', register: 'Créer un compte', username: 'Identifiant', password: 'Mot de passe', createBtn: 'Créer mon compte',
    accountRules: 'Identifiant de 3 à 32 caractères ; mot de passe d’au moins 10 caractères. Notez-le : la récupération par e-mail n’existe pas encore.',
    accountsOffText: 'Ce serveur ne propose pas de comptes : vos sauvegardes restent sur cet appareil, exportez-les pour les garder ailleurs.',
    connected: 'Compte connecté. Vos données locales restent sur cet appareil.',
    // questions
    cancel: 'Annuler', cancelled: 'Annulé.', done: 'Terminé.',
    importAsk: (g) => `Restaurer la sauvegarde de ${g} ?`, importAskText: 'Les données actuelles de cet appareil seront gardées dans une copie de secours.', importOk: 'Restaurer',
    cacheAsk: (g) => `Vider le cache de ${g} ?`, cacheAskText: 'Les fichiers du jeu seront téléchargés de nouveau si besoin. Vos sauvegardes ne sont pas touchées.', cacheOk: 'Vider le cache',
    savesAsk: (g) => `Effacer les sauvegardes de ${g} ?`, savesAskText: 'C’est définitif sur cet appareil. Exportez-les d’abord si vous voulez les garder.', savesOk: 'Effacer',
    asideAsk: 'Supprimer cette copie de secours ?', asideAskText: 'Elle sera supprimée définitivement.',
    publishAsk: 'Publier les données de cet appareil ?', publishAskText: 'Elles deviennent la nouvelle version en ligne ; la précédente reste dans l’historique.', publishOk: 'Publier',
    restoreAsk: (g) => `Restaurer la copie en ligne de ${g} ?`, restoreAskText: 'Les données actuelles de cet appareil seront gardées dans une copie de secours.',
    deleteOnlineAsk: (g) => `Effacer les copies en ligne de ${g} ?`, deleteOnlineAskText: 'Toutes les versions en ligne disparaissent. Les sauvegardes de cet appareil ne sont pas touchées.',
    accountAsk: 'Supprimer votre compte ?', accountAskText: 'Toutes les copies en ligne seront effacées ; les données de cet appareil restent intactes. Saisissez votre mot de passe pour confirmer.',
    finalAsk: 'Dernière confirmation', finalAskText: 'Le compte et toutes ses sauvegardes en ligne seront supprimés définitivement.', finalOk: 'Oui, supprimer',
    // work and results
    wExport: 'Préparation de la sauvegarde', wImport: 'Import de la sauvegarde', wCache: 'Nettoyage du cache', wSaves: 'Suppression des sauvegardes', wAside: 'Suppression de la copie',
    wSend: 'Envoi de la sauvegarde', wSync: 'Synchronisation', wRestore: 'Restauration depuis le cloud', wDownload: 'Téléchargement de la version', wDeleteOnline: 'Suppression de la copie en ligne',
    wHistory: 'Chargement de l’historique', wLogin: 'Connexion', wRegister: 'Création du compte', wLogout: 'Déconnexion', wPassword: 'Modification du mot de passe', wAccount: 'Suppression du compte',
    rExported: (s) => `Sauvegarde téléchargée : ${s}.`, rNoSave: 'Ce jeu n’a pas encore de sauvegarde sur cet appareil.', rQuit: 'Quittez ce jeu avant d’importer, de restaurer ou de nettoyer.',
    rImported: (a) => 'Sauvegarde restaurée.' + (a ? ' Une copie des données précédentes a été gardée.' : ''), rCache: 'Cache vidé, sauvegardes conservées.', rSaves: 'Sauvegardes de cet appareil supprimées.', rAside: 'Copie supprimée.',
    rTooBig: 'Cette sauvegarde dépasse la limite de 64 Mo de la copie en ligne. L’export reste possible.', rAlready: 'Cette sauvegarde est déjà en ligne.',
    rDiffers: 'La copie en ligne diffère de celle de cet appareil. Choisissez « Envoyer » pour la remplacer ou « Restaurer » pour la récupérer.',
    rSent: (v) => 'Sauvegarde envoyée' + (v ? ` (version ${v})` : '') + '.', rSynced: (n, c) => `${n} sauvegarde(s) envoyée(s).` + (c ? ` ${c} conflit(s) à examiner dans l’onglet En ligne.` : ''),
    rRestored: (a) => 'Sauvegarde restaurée.' + (a ? ' L’ancienne copie de cet appareil a été gardée.' : ''), rVersion: (v) => `Version ${v} téléchargée.`, rDeleted: 'Copies en ligne supprimées ; les données de cet appareil restent intactes.',
    rHistory: 'Historique chargé.', rAccountDeleted: 'Compte supprimé. Les sauvegardes de cet appareil sont conservées.', errConnection: 'Erreur de connexion.',
  },
  en: {
    title: 'My data', subtitle: 'Saves and storage', close: 'Close',
    tabDevice: 'This device', tabCloud: 'Online', tabAccount: 'Account',
    hintUsed: (b) => `${b} used`, hintReading: 'Reading…', hintCloud: 'Sync', hintCloudOff: 'Account needed', hintAccount: 'Optional',
    sideNote: 'Playing needs no account. Your games stay in this browser unless you send them.',
    deviceTitle: 'Saved games and game cache',
    deviceLead: 'Your games and settings, and the game files already downloaded, are kept in this browser. Export your saves to keep them elsewhere.',
    used: 'Space used', ofQuota: (b) => `of ${b} available`, quotaUnknown: 'Quota unavailable',
    protection: 'Storage protection', protectionOn: 'Enabled', protectionOnText: 'The browser will avoid erasing this data.',
    protectionOff: 'Not enabled', protectionOffText: 'Otherwise the browser may erase it when space runs short.', protectionAsk: 'Enable protection',
    protectionWork: 'Requesting protection', protectionDone: 'Protection enabled.', protectionDenied: 'The browser declined the request.',
    games: 'Your games', saves: 'Saves', cache: 'Cache', cacheHelp: 'Game files already downloaded: they can be downloaded again.',
    export: 'Export', import: 'Import', clean: 'Clean up',
    cleanCache: 'Clear the cache', cleanCacheText: 'The game files will be downloaded again at the next launch.',
    cleanSaves: 'Erase the saves', cleanSavesText: 'Permanently deletes the games and settings on this device.',
    playing: 'Game running: import and clean-up are possible once you have left it.',
    noData: (n) => `Games with no data on this device (${n})`, noGames: 'No games', noGamesText: 'Games will show up here as soon as the server offers them.',
    asides: 'Safety copies', asidesText: 'Kept automatically before a restore. Delete them when you no longer need them.',
    delete: 'Delete', more: 'More options',
    cloudTitle: 'Online backup',
    cloudLead: 'Copy your saves to your account to find them on another device. Game files are never uploaded.',
    cloudOffTitle: 'Find your games anywhere', cloudOffText: 'Sign in to keep a copy of your saves online. It is optional: the game works fine without.',
    signIn: 'Sign in or create an account', accountsOff: 'Accounts are not enabled on this server.',
    signedAs: (n) => `Signed in: ${n}`, keeps: 'Up to 20 versions kept per game.', syncAll: 'Sync now',
    online: 'Online', version: (v) => `version ${v}`, noCopy: 'No online copy yet',
    send: 'Send', restore: 'Restore', downloadBtn: 'Download', history: 'History', deleteOnline: 'Delete online',
    noSaves: 'No saves yet', noSavesText: 'Start a game, then come back here to make its first online copy.',
    conflictNote: 'If this device and the server differ, nothing is overwritten automatically: you choose which version to keep.',
    accountTitle: 'Your account', accountLead: 'Optional. It only keeps your saves online: you can play without one.',
    signedIn: 'Signed in', signOut: 'Sign out', signOutDone: 'Signed out. The saves on this device stay here.',
    changePassword: 'Change password', oldPassword: 'Current password', newPassword: 'New password', changePasswordBtn: 'Change password', passwordChanged: 'Password changed.',
    deleteAccount: 'Delete account', deleteAccountText: 'Erases every online copy. The data on this device is untouched.', deleteAccountBtn: 'Delete my account',
    login: 'Sign in', register: 'Create account', username: 'Username', password: 'Password', createBtn: 'Create my account',
    accountRules: 'Username of 3 to 32 characters; password of at least 10 characters. Write it down: there is no e-mail recovery yet.',
    accountsOffText: 'This server has no accounts: your saves stay on this device, export them to keep them elsewhere.',
    connected: 'Signed in. Your local data stays on this device.',
    cancel: 'Cancel', cancelled: 'Cancelled.', done: 'Done.',
    importAsk: (g) => `Restore the save of ${g}?`, importAskText: 'The current data on this device will be kept in a safety copy.', importOk: 'Restore',
    cacheAsk: (g) => `Clear the cache of ${g}?`, cacheAskText: 'The game files will be downloaded again if needed. Your saves are not touched.', cacheOk: 'Clear the cache',
    savesAsk: (g) => `Erase the saves of ${g}?`, savesAskText: 'This is final on this device. Export them first if you want to keep them.', savesOk: 'Erase',
    asideAsk: 'Delete this safety copy?', asideAskText: 'It will be deleted for good.',
    publishAsk: 'Publish the data of this device?', publishAskText: 'It becomes the new online version; the previous one stays in the history.', publishOk: 'Publish',
    restoreAsk: (g) => `Restore the online copy of ${g}?`, restoreAskText: 'The current data on this device will be kept in a safety copy.',
    deleteOnlineAsk: (g) => `Delete the online copies of ${g}?`, deleteOnlineAskText: 'Every online version disappears. The saves on this device are not touched.',
    accountAsk: 'Delete your account?', accountAskText: 'Every online copy will be erased; the data on this device is untouched. Enter your password to confirm.',
    finalAsk: 'Last confirmation', finalAskText: 'The account and all its online saves will be deleted for good.', finalOk: 'Yes, delete',
    wExport: 'Preparing the save', wImport: 'Importing the save', wCache: 'Clearing the cache', wSaves: 'Erasing the saves', wAside: 'Deleting the copy',
    wSend: 'Sending the save', wSync: 'Syncing', wRestore: 'Restoring from the cloud', wDownload: 'Downloading the version', wDeleteOnline: 'Deleting the online copy',
    wHistory: 'Loading the history', wLogin: 'Signing in', wRegister: 'Creating the account', wLogout: 'Signing out', wPassword: 'Changing the password', wAccount: 'Deleting the account',
    rExported: (s) => `Save downloaded: ${s}.`, rNoSave: 'This game has no save on this device yet.', rQuit: 'Leave this game before importing, restoring or cleaning up.',
    rImported: (a) => 'Save restored.' + (a ? ' A copy of the previous data was kept.' : ''), rCache: 'Cache cleared, saves kept.', rSaves: 'Saves on this device deleted.', rAside: 'Copy deleted.',
    rTooBig: 'This save exceeds the 64 MB limit of online copies. Export is still possible.', rAlready: 'This save is already online.',
    rDiffers: 'The online copy differs from this device’s. Choose “Send” to replace it or “Restore” to get it.',
    rSent: (v) => 'Save sent' + (v ? ` (version ${v})` : '') + '.', rSynced: (n, c) => `${n} save(s) sent.` + (c ? ` ${c} conflict(s) to review in the Online tab.` : ''),
    rRestored: (a) => 'Save restored.' + (a ? ' The previous copy on this device was kept.' : ''), rVersion: (v) => `Version ${v} downloaded.`, rDeleted: 'Online copies deleted; the data on this device is untouched.',
    rHistory: 'History loaded.', rAccountDeleted: 'Account deleted. The saves on this device are kept.', errConnection: 'Connection error.',
  },
};
/** The accounts API answers in French: its known messages, for the English window. */
const ERR_EN = {
  'Origine refusée.': 'Origin refused.', 'Origine requise.': 'Origin required.', 'Trop de tentatives. Réessaie plus tard.': 'Too many attempts. Try again later.', 'Trop de tentatives.': 'Too many attempts.',
  'Identifiant : 3 à 32 caractères, lettres, chiffres, point, tiret ou souligné.': 'Username: 3 to 32 characters, letters, digits, dot, dash or underscore.',
  'Le mot de passe doit contenir de 10 à 128 caractères.': 'The password must be 10 to 128 characters long.', 'Cet identifiant est déjà pris.': 'This username is already taken.',
  'Identifiant ou mot de passe incorrect.': 'Wrong username or password.', 'Connexion requise.': 'Sign-in required.', 'Le nouveau mot de passe doit contenir de 10 à 128 caractères.': 'The new password must be 10 to 128 characters long.',
  'Mot de passe actuel incorrect.': 'Current password is wrong.', 'Mot de passe incorrect.': 'Wrong password.', 'Introuvable.': 'Not found.', 'Jeu introuvable.': 'Game not found.', 'Sauvegarde introuvable.': 'Save not found.',
  'Trop d’envois. Réessaie dans une minute.': 'Too many uploads. Try again in a minute.', 'Version de départ invalide.': 'Invalid starting version.', 'Sauvegarde trop volumineuse.': 'Save too large.',
  'Fichier de sauvegarde invalide.': 'Invalid save file.', 'Contenu de sauvegarde invalide.': 'Invalid save content.', 'Une autre sauvegarde existe en ligne.': 'Another save exists online.',
  'Espace cloud plein (512 Mo). Supprime une ancienne copie en ligne.': 'Cloud space full (512 MB). Delete an old online copy.', 'L’espace cloud du site est plein.': 'The site’s cloud space is full.', 'Méthode refusée.': 'Method not allowed.',
};
let lang = pickLang();
const t = (key, ...args) => { const v = TEXT[lang][key] ?? TEXT.en[key] ?? key; return typeof v === 'function' ? v(...args) : v; };
const fmtBytes = (n) => {
  if (!Number.isFinite(n) || n < 0) return '—';
  const units = lang === 'fr' ? ['o', 'Ko', 'Mo', 'Go', 'To'] : ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toLocaleString(lang, { maximumFractionDigits: n < 10 && i ? 1 : 0 }) + ' ' + units[i];
};
const stamp = (ms) => ms ? new Date(ms).toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

// ---------------------------------------------------------------- state
const app = {
  tab: 'device', open: false, busy: false, account: null, accountsOn: null, cloud: new Map(), storage: null,
  games: new Map(), accountMode: 'login', expanded: null, histories: new Map(), message: '', tone: 'info', opened: new Set(),
};
const showAll = new URLSearchParams(location.search).has('all');
const state = () => window.orthros;
const activeGame = (game) => state()?.manifest === game && ['running', 'loading', 'starting'].includes(state()?.status);
const nameOf = (game) => app.games.get(game)?.title ?? game;
const versionOf = (game) => app.games.get(game)?.version ?? null;
const knownKey = (game) => 'orthros.cloud.' + app.account?.username + '.' + game;
const getKnown = (game) => localStorage.getItem(knownKey(game));
const setKnown = (game, hash) => localStorage.setItem(knownKey(game), hash);

// ---------------------------------------------------------------- server
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  if (!response.ok) {
    let error; try { error = (await response.json()).error; } catch { error = null; }
    const issue = new Error((lang === 'fr' ? error : ERR_EN[error] ?? error) || t('errConnection'));
    issue.status = response.status;
    throw issue;
  }
  return response;
}
async function jsonApi(path, method = 'GET', body) {
  const response = await api(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  return response.json();
}
async function refresh({ account = false } = {}) {
  if (account) {
    app.accountsOn = await fetch('/api/config').then((r) => r.json()).then((c) => !!c.accounts).catch(() => false);
    try { app.account = app.accountsOn ? (await jsonApi('/api/account')).user : null; } catch { app.account = null; }
  }
  const [storage, manifests] = await Promise.all([scanStorage(), fetch('/api/manifests').then((r) => r.json()).catch(() => [])]);
  app.storage = storage;
  app.games = new Map(manifests.map((m) => [m.name, { title: m.title ?? m.name, version: m.version ?? null, hidden: !!m.hidden }]));
  if (app.account) {
    try { app.cloud = new Map((await jsonApi('/api/cloud')).games.map((g) => [g.game, g])); } catch { app.cloud = new Map(); }
  } else app.cloud = new Map();
  render();
}
/** Runs an action: the status line says what is going on, then what came out of it; the window is redrawn after. */
async function run(label, task, reload = true) {
  if (app.busy) return;
  app.busy = true; app.tone = 'info'; app.message = label + '…'; render();
  try {
    const result = await task();
    app.tone = 'ok'; app.message = result || t('done');
    if (reload) await refresh();
  } catch (error) { app.tone = 'error'; app.message = error.message || String(error); render(); }
  finally { app.busy = false; render(); }
}

// ---------------------------------------------------------------- pieces
const ICONS = {
  device: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 9.5 4 4 0 0 1 17.5 18H7z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  shield: '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 16V5M7 9l5-5 5 5M5 20h14"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  sync: '<path d="M20 11a8 8 0 0 0-14-4L4 9M4 5v4h4M4 13a8 8 0 0 0 14 4l2-2M20 19v-4h-4"/>',
  check: '<path d="M5 12l4 4 10-10"/>',
  alert: '<path d="M12 4l9 16H3L12 4zM12 10v4M12 17v.5"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  restore: '<path d="M4 12a8 8 0 1 0 3-6.2M4 4v5h5"/>',
  box: '<path d="M3 8l9-5 9 5-9 5-9-5zM3 8v8l9 5 9-5V8M12 13v8"/>',
};
const icon = (name) => { const s = h('span', { class: 'dm-ico', 'aria-hidden': 'true' }); s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`; return s; };
/** A button: `variant` primary / ghost / danger, an icon, a key to find it again after a redraw. */
const btn = (label, click, { variant = '', ico = null, key = null, small = false } = {}) =>
  h('button', { type: 'button', class: `dm-btn ${variant}${small ? ' sm' : ''}`, 'data-k': key, disabled: app.busy, onclick: click }, ico ? icon(ico) : null, label);
const row = (...kids) => h('div', { class: 'dm-actions' }, kids.flat().filter(Boolean));
const head = (kicker, title, lead) => h('header', { class: 'dm-head' }, h('span', { class: 'dm-kicker' }, kicker), h('h2', {}, title), h('p', {}, lead));
/** A block that can be opened and closed, remembering its state across redraws. */
const fold = (key, summary, ...kids) => {
  const d = h('details', { class: 'dm-fold' }, h('summary', {}, summary, icon('chevron')), h('div', { class: 'dm-fold-body' }, kids));
  d.open = app.opened.has(key);
  d.ontoggle = () => { if (d.open) app.opened.add(key); else app.opened.delete(key); };
  return d;
};
const panel = (ico, title, text, ...actions) => h('div', { class: 'dm-panel' }, icon(ico), h('div', {}, h('strong', {}, title), h('p', {}, text), actions.flat().some(Boolean) ? row(actions) : null));

// ---------------------------------------------------------------- the window
const dialog = h('dialog', { class: 'dm-dialog', 'aria-labelledby': 'dmTitle' });
const nav = h('nav', { class: 'dm-nav', role: 'tablist', 'aria-orientation': 'vertical' });
const content = h('div', { class: 'dm-scroll', role: 'tabpanel' });
const status = h('div', { class: 'dm-status', role: 'status', 'aria-live': 'polite' });
const asking = h('div', { class: 'dm-ask', hidden: true });
const closeBtn = h('button', { type: 'button', class: 'dm-close', onclick: () => dialog.close() });
const brandTitle = h('strong', { id: 'dmTitle' }), brandSub = h('span'), sideNote = h('p', { class: 'dm-side-note' });
dialog.append(h('div', { class: 'dm-shell' },
  h('aside', { class: 'dm-side' }, h('div', { class: 'dm-brand' }, h('img', { src: '/src/host/web/orthros_logo.png', alt: '', width: 140, height: 143 }), h('div', {}, brandTitle, brandSub)), nav, sideNote),
  h('section', { class: 'dm-main' }, closeBtn, content, status, asking)));
closeBtn.append(icon('close'));
document.body.append(dialog);
dialog.addEventListener('close', () => { app.open = false; });
// (the game behind must not get the keys and the mouse used here — its own key handler cancels every key, Escape included)
dialog.addEventListener('keydown', (event) => { event.stopPropagation(); if (event.key === 'Escape' && asking.hidden) { event.preventDefault(); dialog.close(); } });
dialog.addEventListener('keyup', (event) => event.stopPropagation());
for (const type of ['mousedown', 'mouseup', 'mousemove', 'click', 'wheel']) dialog.addEventListener(type, (e) => e.stopPropagation());
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
let askEscapedAt = 0;
dialog.addEventListener('cancel', (event) => { if (!asking.hidden || Date.now() - askEscapedAt < 150) event.preventDefault(); }); // (Escape closes a question first, not the window)

/** A question inside the window. Resolves to true / false, or to the typed password when `password` is set (null if cancelled). */
function ask({ title, text, ok, danger = false, password = false }) {
  return new Promise((resolve) => {
    const finish = (value) => { asking.hidden = true; asking.replaceChildren(); resolve(value); };
    const input = password ? h('input', { type: 'password', class: 'dm-input', autocomplete: 'current-password', 'aria-label': t('password') }) : null;
    const no = h('button', { type: 'button', class: 'dm-btn ghost', onclick: () => finish(password ? null : false) }, t('cancel'));
    const yes = h('button', { type: 'button', class: 'dm-btn ' + (danger ? 'danger solid' : 'primary'), onclick: () => finish(password ? (input.value || null) : true) }, ok);
    asking.replaceChildren(h('div', { class: 'dm-ask-card' + (danger ? ' danger' : ''), role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title },
      icon(danger ? 'alert' : 'check'), h('h3', {}, title), h('p', {}, text), input, h('div', { class: 'dm-actions end' }, no, yes)));
    asking.onkeydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); askEscapedAt = Date.now(); finish(password ? null : false); }
      else if (e.key === 'Enter' && input && e.target === input) { e.preventDefault(); yes.click(); }
    };
    asking.hidden = false; (input ?? no).focus();
  });
}

// ---------------------------------------------------------------- tab: this device
function gameRow(game, data) {
  const has = !!(data?.profile || data?.cache), card = h('article', { class: 'dm-game' + (has ? '' : ' empty') });
  const version = versionOf(game);
  card.append(h('div', { class: 'dm-game-top' },
    h('div', { class: 'dm-game-icon', 'aria-hidden': 'true' }, (nameOf(game)[0] ?? 'O').toUpperCase()),
    h('div', { class: 'dm-game-id' }, h('strong', {}, nameOf(game)), version ? h('span', { class: 'dm-tag' }, version) : null),
    has ? h('div', { class: 'dm-figs' },
      h('span', {}, t('saves'), h('b', {}, fmtBytes(data.profile ?? 0))),
      h('span', { title: t('cacheHelp') }, t('cache'), h('b', {}, fmtBytes(data.cache ?? 0)))) : null));
  card.append(row(data?.profile ? btn(t('export'), () => exportLocal(game), { variant: 'primary', ico: 'download', key: 'export:' + game, small: true }) : null,
    btn(t('import'), () => pickImport(game), { variant: 'ghost', ico: 'upload', key: 'import:' + game, small: true })));
  if (has) card.append(fold('clean:' + game, t('clean'),
    data.cache ? h('div', { class: 'dm-clean' }, h('div', {}, h('strong', {}, t('cleanCache') + ' · ' + fmtBytes(data.cache)), h('p', {}, t('cleanCacheText'))), btn(t('cleanCache'), () => clearCache(game), { variant: 'danger', ico: 'trash', key: 'cache:' + game, small: true })) : null,
    data.profile ? h('div', { class: 'dm-clean' }, h('div', {}, h('strong', {}, t('cleanSaves') + ' · ' + fmtBytes(data.profile)), h('p', {}, t('cleanSavesText'))), btn(t('cleanSaves'), () => clearProfile(game), { variant: 'danger', ico: 'trash', key: 'saves:' + game, small: true })) : null));
  if (activeGame(game)) card.append(h('p', { class: 'dm-playing' }, icon('alert'), t('playing')));
  return card;
}
function renderDevice() {
  content.append(head(t('tabDevice'), t('deviceTitle'), t('deviceLead')));
  const st = app.storage;
  if (!st) { content.append(h('div', { class: 'dm-skeleton' }, h('i'), h('i'), h('i'))); return; }
  const pct = st.quota ? Math.min(100, Math.max(st.usage ? 1 : 0, st.usage / st.quota * 100)) : 0;
  content.append(h('div', { class: 'dm-stats' },
    h('div', { class: 'dm-stat' }, h('span', { class: 'dm-k' }, t('used')), h('strong', { class: 'dm-big' }, fmtBytes(st.usage)),
      st.quota ? h('div', { class: 'dm-meter', role: 'img', 'aria-label': Math.round(pct) + '%' }, h('i', { style: `width:${pct}%` })) : null,
      h('small', {}, st.quota ? t('ofQuota', fmtBytes(st.quota)) : t('quotaUnknown'))),
    h('div', { class: 'dm-stat' + (st.persistent ? ' good' : ' warn') }, h('span', { class: 'dm-k' }, t('protection')),
      h('strong', { class: 'dm-state' }, icon(st.persistent ? 'shield' : 'alert'), st.persistent ? t('protectionOn') : t('protectionOff')),
      h('small', {}, st.persistent ? t('protectionOnText') : t('protectionOffText')),
      st.persistent ? null : btn(t('protectionAsk'), () => run(t('protectionWork'), async () => ((await navigator.storage.persist()) ? t('protectionDone') : t('protectionDenied'))), { variant: 'primary', key: 'persist', small: true }))));
  const names = new Set([...app.games].filter(([, g]) => showAll || !g.hidden).map(([n]) => n));
  for (const g of st.games) if (g.profile || g.cache) names.add(g.game);
  const sorted = [...names].sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || String(versionOf(b)).localeCompare(String(versionOf(a)), undefined, { numeric: true }));
  const dataOf = (g) => st.games.find((x) => x.game === g);
  const withData = sorted.filter((g) => dataOf(g)?.profile || dataOf(g)?.cache), without = sorted.filter((g) => !withData.includes(g));
  content.append(h('h3', { class: 'dm-section' }, t('games')));
  if (!sorted.length) content.append(panel('box', t('noGames'), t('noGamesText')));
  else {
    if (withData.length) content.append(h('div', { class: 'dm-list' }, withData.map((g) => gameRow(g, dataOf(g)))));
    if (without.length) content.append(fold('nodata', t('noData', without.length), h('div', { class: 'dm-list' }, without.map((g) => gameRow(g, dataOf(g))))));
  }
  if (st.asides.length) {
    content.append(h('h3', { class: 'dm-section' }, t('asides')), h('p', { class: 'dm-sub' }, t('asidesText')));
    content.append(h('div', { class: 'dm-list tight' }, st.asides.map((item) => {
      const m = /^orthros-(.+)-aside-(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)/.exec(item.name), when = m ? new Date(`${m[2]}T${m[3]}:${m[4]}:00Z`).getTime() : 0;
      return h('div', { class: 'dm-line' }, h('span', {}, h('strong', {}, m ? nameOf(m[1]) : item.name), h('small', {}, (when ? stamp(when) + ' · ' : '') + fmtBytes(item.bytes))),
        btn(t('delete'), () => removeAside(item), { variant: 'danger', ico: 'trash', key: 'aside:' + item.name, small: true }));
    })));
  }
}

// ---------------------------------------------------------------- tab: online
function cloudRow(game) {
  const remote = app.cloud.get(game), local = app.storage?.games.find((g) => g.game === game), card = h('article', { class: 'dm-game cloud' });
  const version = versionOf(game);
  card.append(h('div', { class: 'dm-game-top' },
    h('div', { class: 'dm-game-icon', 'aria-hidden': 'true' }, icon('cloud')),
    h('div', { class: 'dm-game-id' }, h('strong', {}, nameOf(game)), version ? h('span', { class: 'dm-tag' }, version) : null),
    h('div', { class: 'dm-figs one' }, remote ? h('span', {}, t('online'), h('b', {}, `${t('version', remote.version)} · ${fmtBytes(remote.size)}`), h('small', {}, stamp(remote.updatedAt))) : h('span', { class: 'dim' }, t('noCopy')))));
  card.append(row(local?.profile ? btn(t('send'), () => uploadGame(game, true), { variant: 'primary', ico: 'upload', key: 'send:' + game, small: true }) : null,
    remote ? btn(t('restore'), () => restoreCloud(game), { variant: 'ghost', ico: 'restore', key: 'restore:' + game, small: true }) : null,
    remote ? btn(t('history'), () => toggleHistory(game), { variant: 'ghost', ico: 'clock', key: 'history:' + game, small: true }) : null));
  if (app.expanded === game) {
    card.append(h('div', { class: 'dm-history' }, (app.histories.get(game) ?? []).map((v) => h('div', { class: 'dm-line' },
      h('span', {}, h('strong', {}, t('version', v.version)), h('small', {}, `${stamp(v.createdAt)} · ${fmtBytes(v.size)}`)),
      row(btn(t('restore'), () => restoreCloud(game, v.version), { variant: 'ghost', ico: 'restore', small: true }), btn(t('downloadBtn'), () => downloadCloud(game, v.version), { variant: 'ghost', ico: 'download', small: true }))))));
  }
  if (remote) card.append(fold('online:' + game, t('more'), h('div', { class: 'dm-clean' }, h('div', {}, h('strong', {}, t('deleteOnline'))), btn(t('deleteOnline'), () => deleteCloud(game), { variant: 'danger', ico: 'trash', key: 'del:' + game, small: true }))));
  return card;
}
function renderCloud() {
  content.append(head(t('tabCloud'), t('cloudTitle'), t('cloudLead')));
  if (!app.account) {
    content.append(panel('cloud', t('cloudOffTitle'), app.accountsOn === false ? t('accountsOff') : t('cloudOffText'),
      app.accountsOn === false ? null : btn(t('signIn'), () => { app.tab = 'account'; render(); }, { variant: 'primary', key: 'signin' })));
    return;
  }
  content.append(h('div', { class: 'dm-bar' }, h('div', {}, h('strong', {}, t('signedAs', app.account.username)), h('small', {}, t('keeps'))),
    btn(t('syncAll'), () => run(t('wSync'), syncAll), { variant: 'primary', ico: 'sync', key: 'sync' })));
  const names = new Set([...app.cloud.keys(), ...(app.storage?.games ?? []).filter((g) => g.profile > 0).map((g) => g.game)]);
  const sorted = [...names].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
  content.append(h('h3', { class: 'dm-section' }, t('games')));
  content.append(sorted.length ? h('div', { class: 'dm-list' }, sorted.map(cloudRow)) : panel('box', t('noSaves'), t('noSavesText')));
  content.append(h('p', { class: 'dm-foot' }, t('conflictNote')));
}

// ---------------------------------------------------------------- tab: account
function field(label, type, name, autocomplete) {
  const input = h('input', { class: 'dm-input', type, name, required: true, autocomplete, minlength: type === 'password' ? 10 : null, maxlength: type === 'password' ? 128 : null });
  return h('label', { class: 'dm-field' }, h('span', {}, label), input);
}
function renderAccount() {
  content.append(head(t('tabAccount'), t('accountTitle'), t('accountLead')));
  if (app.accountsOn === false) { content.append(panel('user', t('accountsOff'), t('accountsOffText'))); return; }
  if (app.account) {
    content.append(h('div', { class: 'dm-who' }, h('div', { class: 'dm-avatar', 'aria-hidden': 'true' }, (app.account.username[0] ?? '?').toUpperCase()),
      h('div', {}, h('strong', {}, app.account.username), h('small', {}, t('signedIn'))),
      btn(t('signOut'), () => run(t('wLogout'), async () => { await jsonApi('/api/account/logout', 'POST'); app.account = null; app.cloud.clear(); return t('signOutDone'); }), { variant: 'ghost', key: 'logout' })));
    const pw = h('form', { class: 'dm-form' }, h('h3', {}, t('changePassword')), field(t('oldPassword'), 'password', 'oldPassword', 'current-password'), field(t('newPassword'), 'password', 'newPassword', 'new-password'),
      h('button', { type: 'submit', class: 'dm-btn primary', disabled: app.busy }, t('changePasswordBtn')));
    pw.onsubmit = (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(pw)); run(t('wPassword'), async () => { await jsonApi('/api/account/password', 'POST', data); pw.reset(); return t('passwordChanged'); }, false); };
    content.append(pw);
    content.append(h('div', { class: 'dm-zone' }, h('div', {}, h('strong', {}, t('deleteAccount')), h('p', {}, t('deleteAccountText'))),
      btn(t('deleteAccountBtn'), () => deleteAccount(), { variant: 'danger', ico: 'trash', key: 'delaccount' })));
    return;
  }
  const seg = h('div', { class: 'dm-seg', role: 'tablist' }, ['login', 'register'].map((mode) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(app.accountMode === mode), class: app.accountMode === mode ? 'on' : '', disabled: app.busy,
    onclick: () => { app.accountMode = mode; render(); } }, t(mode))));
  const form = h('form', { class: 'dm-form' }, field(t('username'), 'text', 'username', 'username'), field(t('password'), 'password', 'password', app.accountMode === 'login' ? 'current-password' : 'new-password'),
    h('button', { type: 'submit', class: 'dm-btn primary', disabled: app.busy }, app.accountMode === 'login' ? t('login') : t('createBtn')));
  form.onsubmit = (event) => {
    event.preventDefault(); const data = Object.fromEntries(new FormData(form));
    run(app.accountMode === 'login' ? t('wLogin') : t('wRegister'), async () => {
      const result = await jsonApi('/api/account/' + app.accountMode, 'POST', data);
      app.account = result.user; app.tab = 'cloud'; form.reset();
      await refresh(); await syncAll(); return t('connected');
    });
  };
  content.append(seg, form, h('p', { class: 'dm-foot' }, t('accountRules')));
}

// ---------------------------------------------------------------- drawing
const TABS = [['device', 'device', 'tabDevice'], ['cloud', 'cloud', 'tabCloud'], ['account', 'user', 'tabAccount']];
function render() {
  const keep = document.activeElement?.dataset?.k, scroll = content.scrollTop;
  brandTitle.textContent = t('title'); brandSub.textContent = t('subtitle'); sideNote.textContent = t('sideNote');
  dialog.setAttribute('aria-label', t('title')); closeBtn.setAttribute('aria-label', t('close')); closeBtn.title = t('close');
  const hint = { device: app.storage ? t('hintUsed', fmtBytes(app.storage.usage)) : t('hintReading'), cloud: app.account ? t('hintCloud') : t('hintCloudOff'), account: app.account ? app.account.username : t('hintAccount') };
  nav.replaceChildren(...TABS.map(([id, ico, label]) => h('button', { type: 'button', role: 'tab', class: 'dm-tab' + (app.tab === id ? ' on' : ''), 'aria-selected': String(app.tab === id), 'data-k': 'tab:' + id,
    onclick: () => { app.tab = id; content.scrollTop = 0; render(); } }, icon(ico), h('span', {}, h('strong', {}, t(label)), h('small', {}, hint[id])))));
  content.replaceChildren();
  ({ device: renderDevice, cloud: renderCloud, account: renderAccount })[app.tab]();
  status.className = 'dm-status ' + (app.message ? app.tone : 'idle'); status.replaceChildren(app.message ? icon(app.tone === 'error' ? 'alert' : app.tone === 'ok' ? 'check' : 'sync') : '', app.message);
  content.scrollTop = scroll;
  if (keep) content.querySelector(`[data-k="${CSS.escape(keep)}"]`)?.focus({ preventScroll: true }) ?? nav.querySelector(`[data-k="${CSS.escape(keep)}"]`)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- actions
async function exportLocal(game) {
  return run(t('wExport'), async () => {
    const bytes = await archiveProfile(game, state());
    if (!bytes) throw new Error(t('rNoSave'));
    download(bytes, game + '-' + new Date().toISOString().slice(0, 10) + '.orthros-save');
    return t('rExported', fmtBytes(bytes.length));
  }, false);
}
const picker = h('input', { type: 'file', accept: '.orthros-save,.gz', hidden: true });
document.body.append(picker);
let importGame = null;
function pickImport(game) {
  if (activeGame(game)) { app.tone = 'error'; app.message = t('rQuit'); render(); return; }
  importGame = game; picker.value = ''; picker.click();
}
picker.onchange = () => {
  const file = picker.files?.[0], game = importGame;
  if (!file || !game) return;
  run(t('wImport'), async () => {
    const archive = await parseArchive(await file.arrayBuffer(), game);
    if (!await ask({ title: t('importAsk', nameOf(game)), text: t('importAskText'), ok: t('importOk') })) return t('cancelled');
    return t('rImported', await restoreProfile(game, archive, state()));
  });
};
function clearCache(game) {
  return run(t('wCache'), async () => {
    if (!await ask({ title: t('cacheAsk', nameOf(game)), text: t('cacheAskText'), ok: t('cacheOk'), danger: true })) return t('cancelled');
    await removeCache(game, state()); return t('rCache');
  });
}
function clearProfile(game) {
  return run(t('wSaves'), async () => {
    if (!await ask({ title: t('savesAsk', nameOf(game)), text: t('savesAskText'), ok: t('savesOk'), danger: true })) return t('cancelled');
    await removeProfile(game, state()); return t('rSaves');
  });
}
function removeAside(item) {
  return run(t('wAside'), async () => {
    if (!await ask({ title: t('asideAsk'), text: t('asideAskText'), ok: t('delete'), danger: true })) return t('cancelled');
    await (await navigator.storage.getDirectory()).removeEntry(item.name, { recursive: true }); return t('rAside');
  });
}
async function uploadGame(game, force = false) {
  return run(t('wSend'), async () => {
    const bytes = await archiveProfile(game, state());
    if (!bytes) throw new Error(t('rNoSave'));
    if (bytes.length > 64 * 1024 * 1024) throw new Error(t('rTooBig'));
    const hash = await hashBytes(bytes), remote = app.cloud.get(game), parent = remote?.hash ?? 'none';
    if (hash === parent) { setKnown(game, hash); return t('rAlready'); }
    if (remote && getKnown(game) !== parent && !force) throw new Error(t('rDiffers'));
    if (remote && force && !await ask({ title: t('publishAsk'), text: t('publishAskText'), ok: t('publishOk') })) return t('cancelled');
    const response = await api('/api/cloud/' + encodeURIComponent(game), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Orthros-Parent-Hash': parent }, body: bytes });
    const result = await response.json();
    setKnown(game, result.hash);
    return t('rSent', result.version);
  });
}
async function syncAll() {
  const rows = (app.storage?.games ?? []).filter((g) => g.profile > 0);
  let uploaded = 0, conflicts = 0;
  for (const item of rows) {
    const game = item.game, bytes = await archiveProfile(game, state());
    if (!bytes || bytes.length > 64 * 1024 * 1024) continue;
    const hash = await hashBytes(bytes), remote = app.cloud.get(game), parent = remote?.hash ?? 'none';
    if (hash === parent) { setKnown(game, hash); continue; }
    if (remote && getKnown(game) !== parent) { conflicts++; continue; }
    try {
      const response = await api('/api/cloud/' + encodeURIComponent(game), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Orthros-Parent-Hash': parent }, body: bytes });
      const result = await response.json();
      setKnown(game, result.hash);
      app.cloud.set(game, { game, hash: result.hash, version: result.version ?? remote?.version, size: bytes.length, updatedAt: Date.now() });
      uploaded++;
    } catch (error) { if (error.status === 409) conflicts++; else throw error; }
  }
  return t('rSynced', uploaded, conflicts);
}
async function restoreCloud(game, version) {
  return run(t('wRestore'), async () => {
    if (activeGame(game)) throw new Error(t('rQuit'));
    if (!await ask({ title: t('restoreAsk', nameOf(game)), text: t('restoreAskText'), ok: t('importOk') })) return t('cancelled');
    const url = '/api/cloud/' + encodeURIComponent(game) + (version ? '/' + version : '');
    const archive = await parseArchive(new Uint8Array(await (await api(url)).arrayBuffer()), game);
    const aside = await restoreProfile(game, archive, state());
    const latest = app.cloud.get(game);
    if (latest) setKnown(game, latest.hash);
    return t('rRestored', aside);
  });
}
async function downloadCloud(game, version) {
  return run(t('wDownload'), async () => {
    download(new Uint8Array(await (await api('/api/cloud/' + encodeURIComponent(game) + '/' + version)).arrayBuffer()), game + '-v' + version + '.orthros-save');
    return t('rVersion', version);
  }, false);
}
async function deleteCloud(game) {
  return run(t('wDeleteOnline'), async () => {
    if (!await ask({ title: t('deleteOnlineAsk', nameOf(game)), text: t('deleteOnlineAskText'), ok: t('delete'), danger: true })) return t('cancelled');
    await api('/api/cloud/' + encodeURIComponent(game), { method: 'DELETE' });
    localStorage.removeItem(knownKey(game));
    return t('rDeleted');
  });
}
async function toggleHistory(game) {
  if (app.expanded === game) { app.expanded = null; render(); return; }
  return run(t('wHistory'), async () => {
    app.histories.set(game, (await jsonApi('/api/cloud/' + encodeURIComponent(game) + '/history')).versions); app.expanded = game;
    return t('rHistory');
  }, false);
}
async function deleteAccount() {
  return run(t('wAccount'), async () => {
    const password = await ask({ title: t('accountAsk'), text: t('accountAskText'), ok: t('deleteAccountBtn'), danger: true, password: true });
    if (!password) return t('cancelled');
    if (!await ask({ title: t('finalAsk'), text: t('finalAskText'), ok: t('finalOk'), danger: true })) return t('cancelled');
    await jsonApi('/api/account', 'DELETE', { password });
    app.account = null; app.cloud.clear();
    return t('rAccountDeleted');
  });
}

// ---------------------------------------------------------------- entry points
function open(tab = 'device') {
  if (document.pointerLockElement) document.exitPointerLock();
  lang = pickLang();
  app.tab = tab; app.open = true; app.message = ''; app.tone = 'info'; asking.hidden = true;
  render();
  dialog.showModal();
  refresh({ account: true }).catch((error) => { app.tone = 'error'; app.message = error.message; render(); });
}
// home screen: the button sits in the header (its label follows the page language, see home.js); in game: in the game header
const menuButton = h('button', { type: 'button', class: 'hm-btn hm-btn-data', onclick: () => open() }, t('title'));
document.querySelector('#menu [data-slot="data"]')?.append(menuButton);
document.querySelector('#topbar')?.insertBefore(h('button', { type: 'button', class: 'dm-bar-entry', onclick: () => open() }, t('title')), document.querySelector('#tbFull'));

setInterval(() => {
  if (app.account && !app.busy) refresh().then(() => syncAll()).then((message) => {
    if (app.open) { app.tone = 'ok'; app.message = message; render(); }
  }).catch((error) => { if (app.open) { app.tone = 'error'; app.message = error.message; render(); } });
}, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && app.account && !app.busy) refresh().then(syncAll).catch(() => {});
});
