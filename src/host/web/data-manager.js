// "My data": what the browser keeps for the visitor — the saves and settings of each game, the game files already
// downloaded — and the optional account that copies the saves online. A window over the page (opened from the home
// screen and from the in-game header); it follows the page language.
import { offlineCopy } from '../../vfs/data-client.js';
import { archiveProfile, download, parseArchive, removeCache, removeOther, removeProfile, restoreProfile, scanStorage, profileFiles, replaceProfile, scanPorts, portFiles, clearPortCache, clearPortSaves, MAX_RAW } from './data-store.js';
import { pickLang } from './lang.js';
import { h } from './dom.js';
import { errorText, accountChanged, onAccountChange, googleSignIn, googleText, GOOGLE_G } from './account.js';
import { CloudSave, MAX_BACKUP, encodeProfile } from './cloud-sync.js';
import { cloudProfile, portProfileDb } from '../../vfs/profile-share.js';

// ---------------------------------------------------------------- text
const TEXT = {
  fr: {
    title: 'Paramètres', subtitle: 'Options et sauvegardes', close: 'Fermer',
    tabGeneral: 'Général', tabDevice: 'Cet appareil', tabCloud: 'En ligne', tabAccount: 'Compte',
    hintGeneral: 'Options du lanceur', hintUsed: (b) => `${b} utilisés`, hintReading: 'Lecture…', hintCloud: 'Synchronisation', hintCloudOff: 'Compte requis',
    sideNote: 'Connecté, tes parties sont sauvegardées automatiquement sur ton compte et le multijoueur est ouvert. Sans compte, elles restent seulement dans ce navigateur.',
    // general
    generalTitle: 'Options du lanceur', generalLead: 'Quelques réglages valables pour tous tes jeux. Tes sauvegardes et le stockage sont dans les onglets suivants.',
    offline: 'Copie hors ligne', offlineText: 'Télécharge tout le dossier du jeu dans le stockage du navigateur, en arrière-plan : les lancements suivants ne lisent plus rien sur le réseau.',
    log: 'Journal de débogage', logText: 'Affiche le journal de l’émulateur par-dessus le jeu.', nextLaunch: ' S’applique au prochain lancement.',
    // this device
    deviceTitle: 'Sauvegardes et cache des jeux',
    deviceLead: 'Tes parties et réglages, ainsi que les fichiers de jeu déjà téléchargés, sont rangés dans ce navigateur. Exporte tes sauvegardes pour les garder ailleurs.',
    used: 'Espace utilisé', ofQuota: (b) => `sur ${b} disponibles`, quotaUnknown: 'Quota indisponible',
    protection: 'Protection du stockage', protectionOn: 'Activée', protectionOnText: 'Le navigateur évitera d’effacer ces données.',
    protectionOff: 'À activer', protectionOffText: 'Sinon, le navigateur peut les effacer s’il manque de place.', protectionAsk: 'Activer la protection',
    protectionWork: 'Demande de protection', protectionDone: 'Protection activée.', protectionDenied: 'Le navigateur a refusé la demande.',
    games: 'Tes jeux', saves: 'Sauvegardes', cache: 'Cache', cacheHelp: 'Fichiers du jeu déjà téléchargés : ils peuvent l’être de nouveau.',
    export: 'Exporter', import: 'Importer', clean: 'Nettoyer',
    cleanCache: 'Vider le cache', cleanCacheText: 'Les fichiers du jeu seront téléchargés de nouveau au prochain lancement.',
    sharedWith: (g) => `Ces fichiers servent aussi à ${g} : ils y seront téléchargés de nouveau si besoin.`,
    keptUnder: (g) => `Les fichiers que ce jeu partage avec ${g} sont désormais gardés sous ${g} : les copies que ce cache en garde encore y passent à mesure qu'elles sont lues, et le vider libère l'espace qu'elles occupaient.`,
    cleanSaves: 'Effacer les sauvegardes', cleanSavesText: 'Supprime définitivement les parties et réglages de cet appareil.',
    sharedBy: (v) => `Sauvegardes partagées par : ${v}`, cleanSavesShared: (v) => `Supprime définitivement les parties et réglages de cet appareil, pour toutes les versions du jeu (${v}).`,
    oldCopies: 'Anciennes copies', oldCopiesText: 'Les sauvegardes que chaque version gardait avant d’être partagées par le jeu : elles y ont été reprises. Supprime-les quand tu as vérifié tes parties.',
    oldAsk: (g) => `Supprimer l’ancienne copie de ${g} ?`, oldAskText: 'Ses parties ont été reprises dans les sauvegardes du jeu. Elle sera supprimée définitivement.',
    playing: 'Jeu en cours : l’import et le nettoyage seront possibles après l’avoir quitté.',
    portOpen: 'Ferme ce jeu dans tes autres onglets avant de nettoyer ses données.',
    noData: (n) => `Jeux sans données sur cet appareil (${n})`, noGames: 'Aucun jeu', noGamesText: 'Les jeux apparaîtront ici dès que le serveur les proposera.',
    asides: 'Copies de secours', asidesText: 'Gardées automatiquement avant une restauration. Supprime-les quand tu n’en as plus besoin.',
    others: 'Autres fichiers de jeu', othersText: 'Gardés par une version précédente d’Orthros : repris au prochain lancement du jeu, téléchargés de nouveau si tu les supprimes.',
    otherNames: { 'orthros-streamfs-1': 'Jeux OpenMW' },
    delete: 'Supprimer', more: 'Plus d’options',
    // online
    cloudTitle: 'Sauvegarde en ligne', portSaves: 'Restauration automatique au lancement. Les copies précédentes peuvent être téléchargées dans l’historique.', playPort: 'Ouvrir le jeu',
    cloudLead: 'Tes sauvegardes sont envoyées sur ton compte pendant que tu joues et reprises au lancement, sur n’importe quel appareil. Les fichiers des jeux ne sont jamais envoyés.',
    cloudOffTitle: 'Attention : rien n’est sauvegardé sur un compte', cloudOffText: 'Sans compte, tes parties restent seulement dans ce navigateur et peuvent être perdues. Connecte-toi pour qu’elles soient sauvegardées automatiquement.',
    signIn: 'Se connecter ou créer un compte', accountsOff: 'Les comptes ne sont pas activés sur ce serveur.',
    toCloud: 'Mes sauvegardes en ligne', signedAs: (n) => `Connecté : ${n}`, keeps: 'Jusqu’à 20 versions conservées par jeu.', syncAll: 'Synchroniser maintenant',
    online: 'En ligne', version: (v) => `version ${v}`, noCopy: 'Pas encore de copie en ligne',
    send: 'Envoyer', restore: 'Restaurer', downloadBtn: 'Télécharger', history: 'Historique', deleteOnline: 'Effacer en ligne',
    noSaves: 'Aucune sauvegarde pour le moment', noSavesText: 'Lance un jeu en étant connecté : sa sauvegarde arrive ici toute seule.',
    conflictNote: 'Si cet appareil et le serveur diffèrent, rien n’est écrasé automatiquement : tu choisis la version à garder.',
    // account
    accountTitle: 'Ton compte', accountLead: 'Ton identité sur Orthros : il garde tes sauvegardes et t’ouvre le multijoueur de tous les jeux.',
    signedIn: 'Connecté', signOut: 'Se déconnecter', signOutDone: 'Déconnecté. Les sauvegardes de cet appareil restent ici.',
    changePassword: 'Changer le mot de passe', oldPassword: 'Mot de passe actuel', newPassword: 'Nouveau mot de passe', changePasswordBtn: 'Modifier le mot de passe', passwordChanged: 'Mot de passe modifié.',
    deleteAccount: 'Supprimer le compte', deleteAccountText: 'Efface toutes les copies en ligne. Les données de cet appareil restent intactes.', deleteAccountBtn: 'Supprimer mon compte',
    login: 'Se connecter', register: 'Créer un compte', username: 'Identifiant', password: 'Mot de passe', createBtn: 'Créer mon compte',
    accountRules: 'Identifiant de 3 à 32 caractères ; mot de passe d’au moins 10 caractères. Note-le : la récupération par e-mail n’existe pas encore.',
    privacy: 'Règles de confidentialité', terms: 'Conditions d’utilisation',
    google: 'Continuer avec Google', or: 'ou avec un identifiant', googleWindow: 'Termine la connexion dans la fenêtre Google.',
    googleTitle: 'Compte Google', googleLinked: (e) => `Lié${e === true ? '' : ` à ${e}`} : tu te connectes en un clic.`, googleNone: 'Pas lié : lie-le pour te connecter en un clic, sans mot de passe.',
    googleLink: 'Lier mon compte Google', googleUnlink: 'Délier', wUnlink: 'Déliaison du compte Google', googleUnlinked: 'Compte Google délié.',
    setPassword: 'Définir un mot de passe', setPasswordBtn: 'Définir le mot de passe', passwordSet: 'Mot de passe défini : tu peux aussi te connecter avec ton identifiant.',
    noPasswordNote: 'Ton compte se connecte avec Google. Un mot de passe te permet aussi de te connecter avec ton identifiant, et de délier Google.',
    accountAskTextName: 'Toutes les copies en ligne seront effacées ; les données de cet appareil restent intactes. Saisis ton identifiant pour confirmer.',
    accountsOffText: 'Ce serveur ne propose pas de comptes : tes sauvegardes restent sur cet appareil, exporte-les pour les garder ailleurs.',
    connected: 'Compte connecté. Tes données locales restent sur cet appareil.',
    // questions
    cancel: 'Annuler', cancelled: 'Annulé.', done: 'Terminé.',
    importAsk: (g) => `Restaurer la sauvegarde de ${g} ?`, importAskText: 'Les données actuelles de cet appareil seront gardées dans une copie de secours.', importOk: 'Restaurer',
    cacheAsk: (g) => `Vider le cache de ${g} ?`, cacheAskText: 'Les fichiers du jeu seront téléchargés de nouveau si besoin. Tes sauvegardes ne sont pas touchées.', cacheOk: 'Vider le cache',
    savesAsk: (g) => `Effacer les sauvegardes de ${g} ?`, savesAskText: 'C’est définitif sur cet appareil. Exporte-les d’abord si tu veux les garder.', savesOk: 'Effacer',
    savesAskShared: (v) => `Elles sont partagées par toutes les versions du jeu (${v}) : toutes les perdent. C’est définitif sur cet appareil ; exporte-les d’abord si tu veux les garder.`,
    asideAsk: 'Supprimer cette copie de secours ?', asideAskText: 'Elle sera supprimée définitivement.',
    publishAsk: 'Publier les données de cet appareil ?', publishAskText: 'Elles deviennent la nouvelle version en ligne ; la précédente reste dans l’historique.', publishOk: 'Publier',
    restoreAsk: (g) => `Restaurer la copie en ligne de ${g} ?`, restoreAskText: 'Les données actuelles de cet appareil seront gardées dans une copie de secours.',
    deleteOnlineAsk: (g) => `Effacer les copies en ligne de ${g} ?`, deleteOnlineAskText: 'Toutes les versions en ligne disparaissent. Les sauvegardes de cet appareil ne sont pas touchées.',
    accountAsk: 'Supprimer ton compte ?', accountAskText: 'Toutes les copies en ligne seront effacées ; les données de cet appareil restent intactes. Saisis ton mot de passe pour confirmer.',
    finalAsk: 'Dernière confirmation', finalAskText: 'Le compte et toutes ses sauvegardes en ligne seront supprimés définitivement.', finalOk: 'Oui, supprimer',
    // work and results
    wExport: 'Préparation de la sauvegarde', wImport: 'Import de la sauvegarde', wCache: 'Nettoyage du cache', wSaves: 'Suppression des sauvegardes', wAside: 'Suppression de la copie',
    wSend: 'Envoi de la sauvegarde', wSync: 'Synchronisation', wRestore: 'Restauration depuis le cloud', wDownload: 'Téléchargement de la version', wDeleteOnline: 'Suppression de la copie en ligne',
    wHistory: 'Chargement de l’historique', wLogin: 'Connexion', wRegister: 'Création du compte', wLogout: 'Déconnexion', wPassword: 'Modification du mot de passe', wAccount: 'Suppression du compte',
    rExported: (s) => `Sauvegarde téléchargée : ${s}.`, rNoSave: 'Ce jeu n’a pas encore de sauvegarde sur cet appareil.', rQuit: 'Quitte ce jeu avant d’importer, de restaurer ou de nettoyer.',
    rImported: (a) => 'Sauvegarde restaurée.' + (a ? ' Une copie des données précédentes a été gardée.' : ''), rCache: 'Cache vidé, sauvegardes conservées.', rSaves: 'Sauvegardes de cet appareil supprimées.', rAside: 'Copie supprimée.',
    rTooBig: 'Cette sauvegarde dépasse la limite de 64 Mo de la copie en ligne. L’export reste possible.', rAlready: 'Cette sauvegarde est déjà en ligne.',
    rDiffers: 'La copie en ligne diffère de celle de cet appareil. Choisis « Envoyer » pour la remplacer ou « Restaurer » pour la récupérer.',
    rSent: (v) => 'Sauvegarde envoyée' + (v ? ` (version ${v})` : '') + '.', rSynced: (n, c) => `${n} sauvegarde(s) envoyée(s).` + (c ? ` ${c} conflit(s) à examiner dans l’onglet En ligne.` : ''),
    rRestored: (a) => 'Sauvegarde restaurée.' + (a ? ' L’ancienne copie de cet appareil a été gardée.' : ''), rVersion: (v) => `Version ${v} téléchargée.`, rDeleted: 'Copies en ligne supprimées ; les données de cet appareil restent intactes.',
    rHistory: 'Historique chargé.', rAccountDeleted: 'Compte supprimé. Les sauvegardes de cet appareil sont conservées.', errConnection: 'Erreur de connexion.',
  },
  en: {
    title: 'Settings', subtitle: 'Options and saves', close: 'Close',
    tabGeneral: 'General', tabDevice: 'This device', tabCloud: 'Online', tabAccount: 'Account',
    hintGeneral: 'Launcher options', hintUsed: (b) => `${b} used`, hintReading: 'Reading…', hintCloud: 'Sync', hintCloudOff: 'Account needed',
    sideNote: 'Signed in, your games are saved on your account automatically and multiplayer is open. Without an account, they stay in this browser only.',
    generalTitle: 'Launcher options', generalLead: 'A few settings for all your games. Saves and storage are in the next tabs.',
    offline: 'Offline copy', offlineText: 'Downloads the whole game folder into this browser’s storage in the background: later launches read nothing from the network.',
    log: 'Debug log', logText: 'Shows the emulator’s log over the game.', nextLaunch: ' Applies at the next launch.',
    deviceTitle: 'Saved games and game cache',
    deviceLead: 'Your games and settings, and the game files already downloaded, are kept in this browser. Export your saves to keep them elsewhere.',
    used: 'Space used', ofQuota: (b) => `of ${b} available`, quotaUnknown: 'Quota unavailable',
    protection: 'Storage protection', protectionOn: 'Enabled', protectionOnText: 'The browser will avoid erasing this data.',
    protectionOff: 'Not enabled', protectionOffText: 'Otherwise the browser may erase it when space runs short.', protectionAsk: 'Enable protection',
    protectionWork: 'Requesting protection', protectionDone: 'Protection enabled.', protectionDenied: 'The browser declined the request.',
    games: 'Your games', saves: 'Saves', cache: 'Cache', cacheHelp: 'Game files already downloaded: they can be downloaded again.',
    export: 'Export', import: 'Import', clean: 'Clean up',
    cleanCache: 'Clear the cache', cleanCacheText: 'The game files will be downloaded again at the next launch.',
    sharedWith: (g) => `These files also serve ${g}: they will be downloaded again there when needed.`,
    keptUnder: (g) => `The files this game shares with ${g} are now kept under ${g}: the copies this cache still holds move there as they are read, and clearing it frees the space they took.`,
    cleanSaves: 'Erase the saves', cleanSavesText: 'Permanently deletes the games and settings on this device.',
    sharedBy: (v) => `Saves shared by: ${v}`, cleanSavesShared: (v) => `Permanently deletes the games and settings on this device, for every version of the game (${v}).`,
    oldCopies: 'Old copies', oldCopiesText: 'The saves each version kept before the game shared them: they were taken into the game’s. Delete them once you have checked your games.',
    oldAsk: (g) => `Delete the old copy of ${g}?`, oldAskText: 'Its games were taken into the game’s saves. It will be deleted for good.',
    playing: 'Game running: import and clean-up are possible once you have left it.',
    portOpen: 'Close this game in your other tabs before cleaning its data.',
    noData: (n) => `Games with no data on this device (${n})`, noGames: 'No games', noGamesText: 'Games will show up here as soon as the server offers them.',
    asides: 'Safety copies', asidesText: 'Kept automatically before a restore. Delete them when you no longer need them.',
    others: 'Other game files', othersText: 'Kept by an earlier version of Orthros: taken back at the game’s next launch, downloaded again if you delete them.',
    otherNames: { 'orthros-streamfs-1': 'OpenMW games' },
    delete: 'Delete', more: 'More options',
    cloudTitle: 'Online backup', portSaves: 'Restored automatically when launching. Previous copies can be downloaded from history.', playPort: 'Open game',
    cloudLead: 'Your saves are sent to your account while you play and come back at launch, on any device. Game files are never uploaded.',
    cloudOffTitle: 'Warning: nothing is saved on an account', cloudOffText: 'Without an account, your games stay in this browser only and can be lost. Sign in to have them saved automatically.',
    signIn: 'Sign in or create an account', accountsOff: 'Accounts are not enabled on this server.',
    toCloud: 'My online saves', signedAs: (n) => `Signed in: ${n}`, keeps: 'Up to 20 versions kept per game.', syncAll: 'Sync now',
    online: 'Online', version: (v) => `version ${v}`, noCopy: 'No online copy yet',
    send: 'Send', restore: 'Restore', downloadBtn: 'Download', history: 'History', deleteOnline: 'Delete online',
    noSaves: 'No saves yet', noSavesText: 'Play a game while signed in: its save arrives here by itself.',
    conflictNote: 'If this device and the server differ, nothing is overwritten automatically: you choose which version to keep.',
    accountTitle: 'Your account', accountLead: 'Your identity on Orthros: it keeps your saves and opens the multiplayer of every game.',
    signedIn: 'Signed in', signOut: 'Sign out', signOutDone: 'Signed out. The saves on this device stay here.',
    changePassword: 'Change password', oldPassword: 'Current password', newPassword: 'New password', changePasswordBtn: 'Change password', passwordChanged: 'Password changed.',
    deleteAccount: 'Delete account', deleteAccountText: 'Erases every online copy. The data on this device is untouched.', deleteAccountBtn: 'Delete my account',
    login: 'Sign in', register: 'Create account', username: 'Username', password: 'Password', createBtn: 'Create my account',
    accountRules: 'Username of 3 to 32 characters; password of at least 10 characters. Write it down: there is no e-mail recovery yet.',
    privacy: 'Privacy policy', terms: 'Terms of use',
    google: 'Continue with Google', or: 'or with a username', googleWindow: 'Finish signing in in the Google window.',
    googleTitle: 'Google account', googleLinked: (e) => `Linked${e === true ? '' : ` to ${e}`}: you sign in with one click.`, googleNone: 'Not linked: link it to sign in with one click, without a password.',
    googleLink: 'Link my Google account', googleUnlink: 'Unlink', wUnlink: 'Unlinking the Google account', googleUnlinked: 'Google account unlinked.',
    setPassword: 'Set a password', setPasswordBtn: 'Set the password', passwordSet: 'Password set: you can also sign in with your username.',
    noPasswordNote: 'Your account signs in with Google. A password also lets you sign in with your username, and unlink Google.',
    accountAskTextName: 'Every online copy will be erased; the data on this device is untouched. Type your username to confirm.',
    accountsOffText: 'This server has no accounts: your saves stay on this device, export them to keep them elsewhere.',
    connected: 'Signed in. Your local data stays on this device.',
    cancel: 'Cancel', cancelled: 'Cancelled.', done: 'Done.',
    importAsk: (g) => `Restore the save of ${g}?`, importAskText: 'The current data on this device will be kept in a safety copy.', importOk: 'Restore',
    cacheAsk: (g) => `Clear the cache of ${g}?`, cacheAskText: 'The game files will be downloaded again if needed. Your saves are not touched.', cacheOk: 'Clear the cache',
    savesAsk: (g) => `Erase the saves of ${g}?`, savesAskText: 'This is final on this device. Export them first if you want to keep them.', savesOk: 'Erase',
    savesAskShared: (v) => `Every version of the game shares them (${v}): all lose them. This is final on this device; export them first if you want to keep them.`,
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
  tab: 'general', open: false, busy: false, account: null, accountsOn: null, cloud: new Map(), storage: null,
  games: new Map(), accountMode: 'login', expanded: null, histories: new Map(), message: '', tone: 'info', opened: new Set(),
  // (profile key -> { title, versions, runtime, launchUrl, hidden }; this browser's data: saves by profile key, caches by
  // version, the copies the versions kept before their profile was shared — `old`)
  profiles: new Map(), local: null,
};
const showAll = new URLSearchParams(location.search).has('all');
const state = () => window.orthros;
// (saves are kept per profile — a game's, shared by its versions, docs/profiles.md: `key` below —, caches per version)
const activeProfile = (key) => (state()?.profileKey ?? state()?.manifest) === key && ['running', 'loading', 'starting'].includes(state()?.status);
const nameOf = (game) => app.games.get(game)?.title ?? app.profiles.get(game)?.title ?? game;
/** A profile's versions ([] for one the catalog does not know). */
const versionsOf = (key) => app.profiles.get(key)?.versions ?? [];
/** A profile shared by several versions: their labels, for "shared by". */
const sharedBy = (key) => (versionsOf(key).length > 1 ? versionsOf(key).map((v) => versionOf(v) ?? v) : null);
const portProfile = (key) => (app.profiles.get(key)?.runtime ?? 'win32') !== 'win32';
/**
 * The other versions that read version `game`'s files (/api/manifests `owners`: the versions whose files a version
 * takes — they are stored under their owner, game-data.js): its cache is theirs too, counted and cleared here only.
 */
const readers = (game) => [...app.games].filter(([n, g]) => n !== game && g.owners.includes(game)).map(([n]) => n);
const versionOf = (game) => app.games.get(game)?.version ?? null;
/** The account's copy of a Windows game's profile kept in this browser (cloud-sync.js), with its latest hash as listed. */
const cloudFor = (key) => {
  const c = new CloudSave({ ...cloudProfile({ name: key, profileKey: key, profileSources: versionsOf(key).map((name) => ({ name })) }), user: app.account?.username, read: () => profileFiles(key, state()), write: (files) => replaceProfile(key, files, state()) });
  c.remoteHash = app.cloud.get(key)?.hash ?? null;
  return c;
};

// ---------------------------------------------------------------- server
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  if (!response.ok) {
    let error; try { error = (await response.json()).error; } catch { error = null; }
    const issue = new Error(errorText(error, lang) || t('errConnection'));
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
    const config = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
    app.accountsOn = !!config.accounts; app.google = !!config.google;
    try { app.account = app.accountsOn ? (await jsonApi('/api/account')).user : null; } catch { app.account = null; }
  }
  const [storage, manifests] = await Promise.all([scanStorage(), fetch('/api/manifests').then((r) => r.json()).catch(() => [])]);
  app.games = new Map(manifests.map((m) => [m.name, { title: m.title ?? m.name, version: m.runtime === 'openmw' ? [m.version, (m.contentLanguages ?? m.languages ?? []).join('/').toUpperCase()].filter(Boolean).join(' · ') : m.version ?? null, hidden: !!m.hidden, runtime: m.runtime, launchUrl: m.launchUrl, saveKey: m.saveKey ?? null, owners: Array.isArray(m.owners) ? m.owners : [], profileKey: m.profileKey ?? m.name }]));
  app.profiles = new Map();
  for (const [name, g] of app.games) {
    if (!app.profiles.has(g.profileKey)) app.profiles.set(g.profileKey, { title: g.title, versions: [], runtime: g.runtime ?? 'win32', launchUrl: g.launchUrl, hidden: true });
    const p = app.profiles.get(g.profileKey); p.versions.push(name); p.hidden &&= g.hidden;
  }
  // (this browser's data: the Windows games' OPFS folders — a profile under its key, a version's own of before an old
  // copy, the caches under each version's name —, the browser ports' databases — the installation's, per version: its
  // cache and its profile of before; the profile's, per game)
  const local = { profiles: new Map(), caches: new Map(), old: [] };
  const add = (map, k, n) => map.set(k, (map.get(k) ?? 0) + n);
  for (const r of storage.games) {
    if (r.cache) add(local.caches, r.game, r.cache);
    if (!r.profile) continue;
    if (!app.profiles.has(r.game) && app.games.has(r.game)) local.old.push({ name: r.game, bytes: r.profile, port: false });
    else add(local.profiles, r.game, r.profile);
  }
  try {
    const ports = manifests.filter((m) => m.saveKey);
    for (const r of await scanPorts(ports.map((m) => ({ name: m.name, saveKey: m.saveKey })))) {
      if (r.cache) add(local.caches, r.game, r.cache);
      if (r.profile) local.old.push({ name: r.game, bytes: r.profile, port: true });
    }
    for (const r of await scanPorts([...new Set(ports.map((m) => m.profileKey ?? m.name))].map((key) => ({ name: key, saveKey: portProfileDb(key) })))) add(local.profiles, r.game, r.profile);
  } catch { /* IndexedDB unavailable */ }
  app.local = local;
  app.storage = storage;
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
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
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

// ---------------------------------------------------------------- the account button of the home screen
/** A green dot and the name on the little person of the home screen while a session is open. */
function updateAccountButton() {
  const b = document.getElementById('hmAccountBtn'); if (!b) return;
  b.toggleAttribute('data-signed', !!app.account);
  if (app.account) b.dataset.user = app.account.username; else delete b.dataset.user;
  b.title = t('tabAccount') + (app.account ? ' · ' + app.account.username : '');
}

// ---------------------------------------------------------------- the window
const dialog = h('dialog', { class: 'dm-dialog', 'aria-labelledby': 'dmTitle' });
const nav = h('nav', { class: 'dm-nav', role: 'tablist', 'aria-orientation': 'vertical' });
const content = h('div', { class: 'dm-scroll', role: 'tabpanel' });
const status = h('div', { class: 'dm-status', role: 'status', 'aria-live': 'polite' });
const asking = h('div', { class: 'dm-ask', hidden: true });
const closeBtn = h('button', { type: 'button', class: 'dm-close', onclick: () => dialog.close() });
const brandTitle = h('strong', { id: 'dmTitle' }), brandSub = h('span'), sideNote = h('p', { class: 'dm-side-note' });
// (the Windows games' page has the launch options and the browser's storage; a browser port's page, the online saves and
// the account only — its own options are the game's)
const winPage = !!document.getElementById('dmParking');
const parking = document.getElementById('dmParking') ?? document.body.appendChild(h('div', { id: 'dmParking', hidden: true }, h('input', { type: 'checkbox', id: 'offlineToggle' }), h('input', { type: 'checkbox', id: 'logToggle' })));
dialog.append(h('div', { class: 'dm-shell' },
  h('aside', { class: 'dm-side' }, h('div', { class: 'dm-brand' }, h('img', { src: '/src/host/web/orthros_logo.png', alt: '', width: 140, height: 143 }), h('div', {}, brandTitle, brandSub)), nav, sideNote),
  h('section', { class: 'dm-main' }, closeBtn, content, status, asking)));
closeBtn.append(icon('close'));
document.body.append(dialog);
dialog.addEventListener('close', () => { app.open = false; });
// (the game behind must not get the keys and the mouse used here — its own key handler cancels every key, Escape included)
dialog.addEventListener('keydown', (event) => { event.stopPropagation(); if (event.key === 'Escape' && asking.hidden) { event.preventDefault(); dialog.close(); } });
for (const type of ['keyup', 'keypress']) dialog.addEventListener(type, (event) => event.stopPropagation()); // (keypress: a game's text input — SDL's)
for (const type of ['mousedown', 'mouseup', 'mousemove', 'click', 'wheel']) dialog.addEventListener(type, (e) => e.stopPropagation());
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
let askEscapedAt = 0;
dialog.addEventListener('cancel', (event) => { if (!asking.hidden || Date.now() - askEscapedAt < 150) event.preventDefault(); }); // (Escape closes a question first, not the window)

/** A question inside the window. Resolves to true / false, or to the typed password when `password` is set — the typed
 * username when `password` is 'username' — (null if cancelled). */
function ask({ title, text, ok, danger = false, password = false }) {
  return new Promise((resolve) => {
    const finish = (value) => { asking.hidden = true; asking.replaceChildren(); resolve(value); };
    const input = password === 'username' ? h('input', { type: 'text', class: 'dm-input', autocomplete: 'off', 'aria-label': t('username') })
      : password ? h('input', { type: 'password', class: 'dm-input', autocomplete: 'current-password', 'aria-label': t('password') }) : null;
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

// ---------------------------------------------------------------- tab: general
// The two launch options are checkboxes of the page (main.js reads them by id): they are wrapped once in a switch, which lives
// in the window's general tab while it shows and in #dmParking otherwise — never out of the document.
function makeSwitch(id) {
  const input = document.getElementById(id), title = h('b'), text = h('small');
  const label = h('label', { class: 'dm-switch' }, input, h('span', { class: 'track' }), h('span', {}, title, text));
  parking.append(label);
  return { label, title, text };
}
const switches = { offline: makeSwitch('offlineToggle'), log: makeSwitch('logToggle') };
// (the offline copy: the player's choice for every game, kept in this browser — src/vfs/data-client.js offlineCopy)
{ const box = document.getElementById('offlineToggle'); box.checked = box.checked || offlineCopy.get(); box.addEventListener('change', () => offlineCopy.set(box.checked)); }
function renderGeneral() {
  content.append(head(t('tabGeneral'), t('generalTitle'), t('generalLead')));
  const playing = ['running', 'loading', 'starting'].includes(state()?.status);
  for (const key of ['offline', 'log']) { switches[key].title.textContent = t(key); switches[key].text.textContent = t(key + 'Text') + (key === 'offline' && playing ? t('nextLaunch') : ''); }
  content.append(h('div', { class: 'dm-switches' }, switches.offline.label, switches.log.label));
}

// ---------------------------------------------------------------- tab: this device
/** This browser's data of a profile: { profile (its saves' bytes), cache (its versions' caches), caches: [[version, bytes]] }. */
function dataOf(key) {
  const caches = (versionsOf(key).length ? versionsOf(key) : [key]).map((v) => [v, app.local?.caches.get(v) ?? 0]).filter(([, n]) => n > 0);
  return { profile: app.local?.profiles.get(key) ?? 0, cache: caches.reduce((n, [, b]) => n + b, 0), caches };
}
/** A game's card: its profile's saves (shared by its versions) and each version's cache. */
function gameRow(key, data) {
  const has = !!(data.profile || data.cache), card = h('article', { class: 'dm-game' + (has ? '' : ' empty') });
  const versions = versionsOf(key), shared = sharedBy(key), version = shared ? null : versionOf(versions[0] ?? key), port = portProfile(key);
  card.append(h('div', { class: 'dm-game-top' },
    h('div', { class: 'dm-game-icon', 'aria-hidden': 'true' }, (nameOf(key)[0] ?? 'O').toUpperCase()),
    h('div', { class: 'dm-game-id' }, h('strong', {}, nameOf(key)), version ? h('span', { class: 'dm-tag' }, version) : null, shared ? h('small', {}, t('sharedBy', shared.join(', '))) : null),
    has ? h('div', { class: 'dm-figs' },
      h('span', {}, t('saves'), h('b', {}, fmtBytes(data.profile))),
      h('span', { title: t('cacheHelp') }, t('cache'), h('b', {}, fmtBytes(data.cache)))) : null));
  // (a browser port: its saves come back from the account at its start — no import here)
  card.append(row(data.profile ? btn(t('export'), () => exportLocal(key), { variant: 'primary', ico: 'download', key: 'export:' + key, small: true }) : null,
    port ? null : btn(t('import'), () => pickImport(key), { variant: 'ghost', ico: 'upload', key: 'import:' + key, small: true })));
  // (each version's cache: its own files — those it shares with another version kept under that one)
  const cacheLine = ([v, bytes]) => h('div', { class: 'dm-clean' }, h('div', {}, h('strong', {}, t('cleanCache') + (shared ? ' · ' + (versionOf(v) ?? v) : '') + ' · ' + fmtBytes(bytes)), h('p', {}, t('cleanCacheText')), readers(v).length ? h('p', {}, t('sharedWith', readers(v).map(nameOf).join(', '))) : null, app.games.get(v)?.owners.length ? h('p', {}, t('keptUnder', app.games.get(v).owners.map(nameOf).join(', '))) : null), btn(t('cleanCache'), () => clearCache(v), { variant: 'danger', ico: 'trash', key: 'cache:' + v, small: true }));
  if (has) card.append(fold('clean:' + key, t('clean'),
    ...data.caches.map(cacheLine),
    data.profile ? h('div', { class: 'dm-clean' }, h('div', {}, h('strong', {}, t('cleanSaves') + ' · ' + fmtBytes(data.profile)), h('p', {}, shared ? t('cleanSavesShared', shared.join(', ')) : t('cleanSavesText'))), btn(t('cleanSaves'), () => clearProfile(key), { variant: 'danger', ico: 'trash', key: 'saves:' + key, small: true })) : null));
  if (port && has) card.append(h('p', { class: 'dm-playing' }, icon('alert'), t('portOpen')));
  if (activeProfile(key)) card.append(h('p', { class: 'dm-playing' }, icon('alert'), t('playing')));
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
  // (one card a profile — a game, or a version keeping its own —; a profile or a cache the catalog no longer lists too)
  const keys = new Set([...app.profiles].filter(([, p]) => showAll || !p.hidden).map(([k]) => k));
  for (const k of app.local?.profiles.keys() ?? []) keys.add(k);
  for (const v of app.local?.caches.keys() ?? []) keys.add(app.games.get(v)?.profileKey ?? v);
  const sorted = [...keys].sort((a, b) => nameOf(a).localeCompare(nameOf(b)) || String(versionOf(versionsOf(b)[0] ?? b)).localeCompare(String(versionOf(versionsOf(a)[0] ?? a)), undefined, { numeric: true }));
  const withData = sorted.filter((k) => dataOf(k).profile || dataOf(k).cache), without = sorted.filter((k) => !withData.includes(k));
  content.append(h('h3', { class: 'dm-section' }, t('games')));
  if (!sorted.length) content.append(panel('box', t('noGames'), t('noGamesText')));
  else {
    if (withData.length) content.append(h('div', { class: 'dm-list' }, withData.map((k) => gameRow(k, dataOf(k)))));
    if (without.length) content.append(fold('nodata', t('noData', without.length), h('div', { class: 'dm-list' }, without.map((k) => gameRow(k, dataOf(k))))));
  }
  // (the copies a game's versions kept before their profile was shared: merged into it, left here for the player)
  const old = app.local?.old ?? [];
  if (old.length) {
    content.append(h('h3', { class: 'dm-section' }, t('oldCopies')), h('p', { class: 'dm-sub' }, t('oldCopiesText')));
    content.append(h('div', { class: 'dm-list tight' }, old.map((item) => h('div', { class: 'dm-line' },
      h('span', {}, h('strong', {}, nameOf(item.name)), h('small', {}, [versionOf(item.name), fmtBytes(item.bytes)].filter(Boolean).join(' · '))),
      btn(t('delete'), () => removeOld(item), { variant: 'danger', ico: 'trash', key: 'old:' + item.name, small: true })))));
  }
  if (st.asides.length) {
    content.append(h('h3', { class: 'dm-section' }, t('asides')), h('p', { class: 'dm-sub' }, t('asidesText')));
    content.append(h('div', { class: 'dm-list tight' }, st.asides.map((item) => {
      const m = /^orthros-(.+)-aside-(\d{4}-\d\d-\d\d)T(\d\d)-(\d\d)/.exec(item.name), when = m ? new Date(`${m[2]}T${m[3]}:${m[4]}:00Z`).getTime() : 0;
      return h('div', { class: 'dm-line' }, h('span', {}, h('strong', {}, m ? nameOf(m[1]) : item.name), h('small', {}, (when ? stamp(when) + ' · ' : '') + fmtBytes(item.bytes))),
        btn(t('delete'), () => removeAside(item), { variant: 'danger', ico: 'trash', key: 'aside:' + item.name, small: true }));
    })));
  }
  const others = (st.others ?? []).filter((item) => item.bytes > 0);
  if (others.length) {
    content.append(h('h3', { class: 'dm-section' }, t('others')), h('p', { class: 'dm-sub' }, t('othersText')));
    content.append(h('div', { class: 'dm-list tight' }, others.map((item) => {
      const name = t('otherNames')[item.name] ?? item.name;
      return h('div', { class: 'dm-line' }, h('span', {}, h('strong', {}, name), h('small', {}, fmtBytes(item.bytes))),
        btn(t('cacheOk'), () => run(t('wCache'), async () => {
          if (!await ask({ title: t('cacheAsk', name), text: t('cacheAskText'), ok: t('cacheOk'), danger: true })) return t('cancelled');
          await removeOther(item.name); return t('rCache');
        }), { variant: 'danger', ico: 'trash', key: 'other:' + item.name, small: true }));
    })));
  }
}

// ---------------------------------------------------------------- tab: online
function cloudRow(game) {
  const remote = app.cloud.get(game), local = app.local?.profiles.get(game) ?? 0, card = h('article', { class: 'dm-game cloud' });
  const shared = sharedBy(game), version = shared ? null : versionOf(versionsOf(game)[0] ?? game), port = portProfile(game);
  card.append(h('div', { class: 'dm-game-top' },
    h('div', { class: 'dm-game-icon', 'aria-hidden': 'true' }, icon('cloud')),
    h('div', { class: 'dm-game-id' }, h('strong', {}, nameOf(game)), version ? h('span', { class: 'dm-tag' }, version) : null, shared ? h('small', {}, t('sharedBy', shared.join(', '))) : null),
    h('div', { class: 'dm-figs one' }, remote ? h('span', {}, t('online'), h('b', {}, `${t('version', remote.version)} · ${fmtBytes(remote.size)}`), h('small', {}, stamp(remote.updatedAt))) : h('span', { class: 'dim' }, t('noCopy')))));
  card.append(row(local && !port ? btn(t('send'), () => uploadGame(game, true), { variant: 'primary', ico: 'upload', key: 'send:' + game, small: true }) : null,
    remote && !port ? btn(t('restore'), () => restoreCloud(game), { variant: 'ghost', ico: 'restore', key: 'restore:' + game, small: true }) : null,
    remote ? btn(t('history'), () => toggleHistory(game), { variant: 'ghost', ico: 'clock', key: 'history:' + game, small: true }) : null));
  if (port && app.profiles.get(game)?.launchUrl) card.append(h('p', {}, t('portSaves')), h('a', { href: app.profiles.get(game).launchUrl }, t('playPort')));
  if (app.expanded === game) {
    card.append(h('div', { class: 'dm-history' }, (app.histories.get(game) ?? []).map((v) => h('div', { class: 'dm-line' },
      h('span', {}, h('strong', {}, t('version', v.version)), h('small', {}, `${stamp(v.createdAt)} · ${fmtBytes(v.size)}`)),
      row(!port ? btn(t('restore'), () => restoreCloud(game, v.version), { variant: 'ghost', ico: 'restore', small: true }) : null, btn(t('downloadBtn'), () => downloadCloud(game, v.version), { variant: 'ghost', ico: 'download', small: true }))))));
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
  // (a version's copy merged into its game's profile — `migratedTo` — is in the profile's: not a row of its own)
  const names = new Set([...[...app.cloud.values()].filter((r) => !r.migratedTo).map((r) => r.game), ...(app.local?.profiles.keys() ?? [])]);
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
const legal = () => h('p', { class: 'dm-foot dm-legal' }, h('a', { href: '/privacy', target: '_blank', rel: 'noopener' }, t('privacy')), ' · ', h('a', { href: '/terms', target: '_blank', rel: 'noopener' }, t('terms')));
function renderAccount() {
  content.append(head(t('tabAccount'), t('accountTitle'), t('accountLead')));
  if (app.accountsOn === false) { content.append(panel('user', t('accountsOff'), t('accountsOffText'))); return; }
  if (app.account) {
    content.append(h('div', { class: 'dm-who' }, h('div', { class: 'dm-avatar', 'aria-hidden': 'true' }, (app.account.username[0] ?? '?').toUpperCase()),
      h('div', {}, h('strong', {}, app.account.username), h('small', {}, t('signedIn'))),
      row(btn(t('toCloud'), () => { app.tab = 'cloud'; render(); }, { variant: 'primary', ico: 'cloud', key: 'tocloud', small: true }),
        btn(t('signOut'), () => run(t('wLogout'), async () => { await jsonApi('/api/account/logout', 'POST'); app.account = null; app.cloud.clear(); updateAccountButton(); accountChanged(null); return t('signOutDone'); }), { variant: 'ghost', key: 'logout', small: true }))));
    // (Google: linked — unlinked only with a password set —, or a button to link it)
    const g = app.account.google;
    if (g || app.google) content.append(h('div', { class: 'dm-zone dm-google' }, h('div', {}, h('strong', {}, googleMark(), t('googleTitle')), h('p', {}, g ? t('googleLinked', g) : t('googleNone'))),
      g ? (app.account.password ? btn(t('googleUnlink'), () => run(t('wUnlink'), async () => { const r = await jsonApi('/api/account/google/unlink', 'POST', {}); app.account = r.user; accountChanged(r.user); return t('googleUnlinked'); }), { variant: 'ghost', key: 'gunlink', small: true }) : null)
        : btn(t('googleLink'), () => withGoogle(true), { key: 'glink', small: true })));
    // (an account made with Google: its first password needs no current one)
    const hasPassword = app.account.password !== false;
    const pw = h('form', { class: 'dm-form' }, hasPassword ? field(t('oldPassword'), 'password', 'oldPassword', 'current-password') : h('p', { class: 'dm-foot' }, t('noPasswordNote')), field(t('newPassword'), 'password', 'newPassword', 'new-password'),
      h('button', { type: 'submit', class: 'dm-btn primary', disabled: app.busy }, hasPassword ? t('changePasswordBtn') : t('setPasswordBtn')));
    pw.onsubmit = (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(pw)); run(t('wPassword'), async () => { await jsonApi('/api/account/password', 'POST', data); pw.reset(); if (!hasPassword) { app.account = { ...app.account, password: true }; accountChanged(app.account); } return hasPassword ? t('passwordChanged') : t('passwordSet'); }, false); };
    content.append(fold('password', hasPassword ? t('changePassword') : t('setPassword'), pw));
    content.append(h('div', { class: 'dm-zone' }, h('div', {}, h('strong', {}, t('deleteAccount')), h('p', {}, t('deleteAccountText'))),
      btn(t('deleteAccountBtn'), () => deleteAccount(), { variant: 'danger', ico: 'trash', key: 'delaccount' })), legal());
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
      app.account = result.user; form.reset(); updateAccountButton(); accountChanged(result.user);
      await refresh(); await syncAll(); return t('connected');
    });
  };
  if (app.google) content.append(h('button', { type: 'button', class: 'dm-google-btn', disabled: app.busy, 'data-k': 'google', onclick: () => withGoogle(false) }, googleMark(), t('google')), h('div', { class: 'dm-or' }, h('span', {}, t('or'))));
  content.append(seg, form, h('p', { class: 'dm-foot' }, t('accountRules')), legal());
}
const googleMark = () => { const s = h('span', { class: 'dm-g', 'aria-hidden': 'true' }); s.innerHTML = GOOGLE_G; return s; };
/** Google in its own window: the status line waits for it without blocking this one (the player may close it). */
async function withGoogle(link) {
  app.tone = 'info'; app.message = t('googleWindow'); render();
  const r = await googleSignIn(lang, { link });
  if (!r.ok) { app.tone = 'error'; app.message = googleText(r, lang); render(); return; }
  if (link) { app.tone = 'ok'; app.message = googleText(r, lang); await refresh({ account: true }); return; }
  await run(t('wLogin'), async () => { await refresh({ account: true }); updateAccountButton(); await syncAll(); return t('connected'); });
}

// ---------------------------------------------------------------- drawing
const TABS = [['general', 'settings', 'tabGeneral'], ['device', 'device', 'tabDevice'], ['cloud', 'cloud', 'tabCloud']].filter(([id]) => winPage || id === 'cloud');
function render() {
  const keep = document.activeElement?.dataset?.k, scroll = content.scrollTop;
  parking.append(switches.offline.label, switches.log.label); // (before the content is cleared: they never leave the document)
  const solo = app.tab === 'account'; // (the account has its own small window: the little person of the home screen)
  dialog.classList.toggle('solo', solo);
  brandTitle.textContent = t('title'); brandSub.textContent = t('subtitle'); sideNote.textContent = t('sideNote');
  dialog.setAttribute('aria-label', solo ? t('tabAccount') : t('title')); closeBtn.setAttribute('aria-label', t('close')); closeBtn.title = t('close');
  const hint = { general: t('hintGeneral'), device: app.storage ? t('hintUsed', fmtBytes(app.storage.usage)) : t('hintReading'), cloud: app.account ? t('hintCloud') : t('hintCloudOff') };
  nav.replaceChildren(...TABS.map(([id, ico, label]) => h('button', { type: 'button', role: 'tab', class: 'dm-tab' + (app.tab === id ? ' on' : ''), 'aria-selected': String(app.tab === id), 'data-k': 'tab:' + id,
    onclick: () => { app.tab = id; content.scrollTop = 0; render(); } }, icon(ico), h('span', {}, h('strong', {}, t(label)), h('small', {}, hint[id])))));
  content.replaceChildren();
  ({ general: renderGeneral, device: renderDevice, cloud: renderCloud, account: renderAccount })[app.tab]();
  status.className = 'dm-status ' + (app.message ? app.tone : 'idle'); status.replaceChildren(app.message ? icon(app.tone === 'error' ? 'alert' : app.tone === 'ok' ? 'check' : 'sync') : '', app.message);
  content.scrollTop = scroll;
  if (keep) (content.querySelector(`[data-k="${CSS.escape(keep)}"]`) ?? nav.querySelector(`[data-k="${CSS.escape(keep)}"]`))?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- actions
const portKey = (game) => app.games.get(game)?.saveKey ?? null;
/** A port's profile's database (the game's: portProfileDb), null for a Windows game. */
const portDb = (key) => (portProfile(key) ? portProfileDb(key) : null);
/** A port's saves as one archive (the account's format): null when it has none. */
async function archivePort(key) {
  const files = await portFiles(portDb(key)); if (!files.length) return null;
  return new Uint8Array(await new Response(new Blob([encodeProfile(key, files)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}
async function exportLocal(game) {
  return run(t('wExport'), async () => {
    const bytes = portDb(game) ? await archivePort(game) : await archiveProfile(game, state());
    if (!bytes) throw new Error(t('rNoSave'));
    download(bytes, game + '-' + new Date().toISOString().slice(0, 10) + '.orthros-save');
    return t('rExported', fmtBytes(bytes.length));
  }, false);
}
const picker = h('input', { type: 'file', accept: '.orthros-save,.gz', hidden: true });
document.body.append(picker);
let importGame = null;
function pickImport(game) {
  if (activeProfile(game)) { app.tone = 'error'; app.message = t('rQuit'); render(); return; }
  importGame = game; picker.value = ''; picker.click();
}
picker.onchange = () => {
  const file = picker.files?.[0], game = importGame;
  if (!file || !game) return;
  run(t('wImport'), async () => {
    const archive = await parseArchive(await file.arrayBuffer(), game, versionsOf(game)); // (an export of one of its versions' own of before too)
    if (!await ask({ title: t('importAsk', nameOf(game)), text: t('importAskText'), ok: t('importOk') })) return t('cancelled');
    return t('rImported', await restoreProfile(game, archive, state()));
  });
};
function clearCache(game) {
  return run(t('wCache'), async () => {
    if (!await ask({ title: t('cacheAsk', nameOf(game)), text: t('cacheAskText'), ok: t('cacheOk'), danger: true })) return t('cancelled');
    // (a port: the files its earlier pages kept in its database too)
    if (portKey(game)) await clearPortCache(portKey(game));
    await removeCache(game, state());
    return t('rCache');
  });
}
function clearProfile(game) {
  return run(t('wSaves'), async () => {
    const shared = sharedBy(game);
    if (!await ask({ title: t('savesAsk', nameOf(game)), text: shared ? t('savesAskShared', shared.join(', ')) : t('savesAskText'), ok: t('savesOk'), danger: true })) return t('cancelled');
    if (portDb(game)) await clearPortSaves(portDb(game)); else await removeProfile(game, state());
    return t('rSaves');
  });
}
/** A version's copy of before its profile was shared (merged into it), deleted. */
function removeOld(item) {
  return run(t('wAside'), async () => {
    if (!await ask({ title: t('oldAsk', nameOf(item.name)), text: t('oldAskText'), ok: t('delete'), danger: true })) return t('cancelled');
    if (item.port) await clearPortSaves(portKey(item.name)); else await removeProfile(item.name, state());
    return t('rAside');
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
    const remote = app.cloud.get(game), c = cloudFor(game);
    if (remote && force && !await ask({ title: t('publishAsk'), text: t('publishAskText'), ok: t('publishOk') })) return t('cancelled');
    const st = force ? await c.resolve('device') : await c.push();
    return outcome(st, true);
  });
}
/** A CloudSave status as the window's result line (or its error). */
function outcome(st, sent) {
  if (st.state === 'saved') return sent ? t('rSent', st.version) : t('rAlready');
  if (st.state === 'conflict') throw new Error(t('rDiffers'));
  if (st.state === 'toobig') throw new Error(t('rTooBig'));
  if (st.state === 'error') throw new Error(errorText(st.message, lang) || t('errConnection'));
  if (st.state === 'off') throw new Error(t('cloudOffText'));
  return t('done');
}
/** A profile its versions share (their copies of before merged into it) never in step with the account here yet. */
const sharedFirst = (key) => versionsOf(key).some((v) => v !== key) && !cloudFor(key).known?.shared;
/** Every Windows game's profile kept in this browser sent when it changed; the conflicts left for the player. */
async function syncAll() {
  // (only the games the server lists — the account keeps no other —, and a profile the account could take: each is
  // read whole into memory, several times its size)
  // (a profile shared by a game's versions not yet in step with the account here, the account having one: left to the
  // game's next start — its first sync merges both without a question, cloud-sync.js)
  const rows = [...(app.local?.profiles ?? [])].map(([game, profile]) => ({ game, profile }))
    .filter((g) => g.profile > 0 && g.profile <= MAX_RAW && !activeProfile(g.game) && app.profiles.has(g.game) && !portProfile(g.game))
    .filter((g) => !sharedFirst(g.game) || !app.cloud.has(g.game));
  let uploaded = 0, conflicts = 0;
  for (const item of rows) {
    const c = cloudFor(item.game), st = await c.push();
    if (st.state === 'conflict') conflicts++;
    else if (st.state === 'saved' && st.version) { uploaded++; app.cloud.set(item.game, { game: item.game, hash: c.remoteHash, version: st.version, size: 0, updatedAt: Date.now() }); }
  }
  return t('rSynced', uploaded, conflicts);
}
async function restoreCloud(game, version) {
  return run(t('wRestore'), async () => {
    if (activeProfile(game)) throw new Error(t('rQuit'));
    if (!await ask({ title: t('restoreAsk', nameOf(game)), text: t('restoreAskText'), ok: t('importOk') })) return t('cancelled');
    if (!version || version === app.cloud.get(game)?.version) { await cloudFor(game).resolve('account'); return t('rRestored', true); }
    // (an older version of the history: put in place, this device's copy kept aside; the account's latest unchanged)
    const archive = await parseArchive(new Uint8Array(await (await api('/api/cloud/' + encodeURIComponent(game) + '/' + version)).arrayBuffer()), game, versionsOf(game));
    return t('rRestored', await restoreProfile(game, archive, state()));
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
    try { localStorage.removeItem(`orthros.sync.${app.account?.username}.${game}`); } catch { /* storage off */ }
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
    // (an account made with Google, without a password: its name typed again)
    const byName = app.account?.password === false;
    const answer = await ask({ title: t('accountAsk'), text: byName ? t('accountAskTextName') : t('accountAskText'), ok: t('deleteAccountBtn'), danger: true, password: byName ? 'username' : true });
    if (!answer) return t('cancelled');
    if (!await ask({ title: t('finalAsk'), text: t('finalAskText'), ok: t('finalOk'), danger: true })) return t('cancelled');
    await jsonApi('/api/account', 'DELETE', byName ? { username: answer.trim().toLowerCase() } : { password: answer });
    app.account = null; app.cloud.clear(); updateAccountButton(); accountChanged(null);
    return t('rAccountDeleted');
  });
}

// ---------------------------------------------------------------- entry points
function open(tab = 'general') {
  if (document.pointerLockElement) document.exitPointerLock();
  if (!winPage && tab !== 'account') tab = 'cloud';
  lang = pickLang();
  app.tab = tab; app.open = true; app.message = ''; app.tone = 'info'; asking.hidden = true;
  render();
  dialog.showModal();
  refresh({ account: true }).then(updateAccountButton).catch((error) => { app.tone = 'error'; app.message = error.message; render(); });
}
// home screen: the two buttons of its header (see index.html); in a game: the header's settings and save indicator
// (shell.js) open it through window.orthrosData — and a game asking for a sign-in (the shared world's link, re3
// play.js), which closes it once signed in
document.getElementById('hmSettingsBtn')?.addEventListener('click', () => open('general'));
document.getElementById('hmAccountBtn')?.addEventListener('click', () => open('account'));
window.orthrosData = { open, close: () => { if (dialog.open) dialog.close(); } };
// is a session open? (a cheap question; the answer only lights the dot of the little person)
fetch('/api/config').then((r) => r.json()).then(async (c) => { app.accountsOn = !!c.accounts; if (c.accounts) app.account = (await jsonApi('/api/account')).user; updateAccountButton(); }).catch(() => {});
// (signed in or out from a game's loading screen: the same here)
onAccountChange(({ user }) => { app.account = user; updateAccountButton(); if (app.open) refresh(); });
// (the home screen: what was played without an account, or offline, sent once signed in; a running game sends its own)
if (document.getElementById('menu')) setTimeout(() => { if (app.account && !state()?.manifest) refresh().then(syncAll).catch(() => {}); }, 4000);
