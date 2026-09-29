import { archiveProfile, download, formatBytes, hashBytes, parseArchive, removeCache, removeProfile, restoreProfile, scanStorage } from './data-store.js';

const app = {
  tab: 'local', open: false, busy: false, account: null, cloud: new Map(), storage: null,
  titles: new Map(), accountMode: 'login', expanded: null, histories: new Map(), message: '',
};
const state = () => window.orthros;
const activeGame = (game) => state()?.manifest === game && ['running', 'loading', 'starting'].includes(state()?.status);
const nameOf = (game) => app.titles.get(game) ?? game;
const knownKey = (game) => 'orthros.cloud.' + app.account?.username + '.' + game;
const getKnown = (game) => localStorage.getItem(knownKey(game));
const setKnown = (game, hash) => localStorage.setItem(knownKey(game), hash);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (label, click, className = '') => {
  const node = el('button', 'dm-button ' + className, label);
  node.type = 'button'; node.onclick = click; node.disabled = app.busy;
  return node;
};
const stamp = (ms) => ms ? new Date(ms).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
  if (!response.ok) {
    let error; try { error = (await response.json()).error; } catch { error = 'Erreur de connexion.'; }
    const issue = new Error(error || 'Erreur de connexion.');
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
    try { app.account = (await jsonApi('/api/account')).user; }
    catch { app.account = null; }
  }
  const [storage, manifests] = await Promise.all([
    scanStorage(),
    fetch('/api/manifests').then((r) => r.json()).catch(() => []),
  ]);
  app.storage = storage;
  app.titles = new Map(manifests.map((m) => [m.name, m.title ?? m.name]));
  if (app.account) {
    try {
      const cloud = await jsonApi('/api/cloud');
      app.cloud = new Map(cloud.games.map((g) => [g.game, g]));
    } catch { app.cloud = new Map(); }
  } else app.cloud = new Map();
  render();
}
async function run(label, task, reload = true) {
  if (app.busy) return;
  app.busy = true; app.message = label + '…'; render();
  try {
    const result = await task();
    app.message = result || 'Terminé.';
    if (reload) await refresh();
  } catch (error) { app.message = error.message || String(error); render(); }
  finally { app.busy = false; render(); }
}

const dialog = el('dialog', 'dm-dialog');
dialog.setAttribute('aria-label', 'Mes données Orthros');
const shell = el('div', 'dm-shell');
const header = el('header', 'dm-header');
const eyebrow = el('div', 'dm-eyebrow', 'ORTHROS  /  ESPACE PERSONNEL');
const title = el('h2', '', 'Vos parties, à votre façon.');
const subtitle = el('p', '', 'Gardez le contrôle de vos sauvegardes et de l’espace utilisé. Le compte est facultatif.');
const close = button('Fermer ×', () => dialog.close(), 'dm-close');
header.append(eyebrow, title, subtitle, close);
const layout = el('div', 'dm-layout');
const nav = el('nav', 'dm-nav');
const content = el('main', 'dm-content');
const status = el('div', 'dm-status');
status.setAttribute('role', 'status');
status.setAttribute('aria-live', 'polite');
layout.append(nav, content);
shell.append(header, layout, status);
dialog.append(shell);
document.body.append(dialog);
dialog.addEventListener('close', () => { app.open = false; });
dialog.addEventListener('keydown', (event) => { if (event.key !== 'Escape') event.stopPropagation(); });
for (const type of ['mousedown', 'mouseup', 'mousemove', 'click', 'wheel']) dialog.addEventListener(type, (e) => e.stopPropagation());
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });

function sectionHeading(kicker, heading, description) {
  const wrap = el('div', 'dm-sectionhead');
  wrap.append(el('span', 'dm-kicker', kicker), el('h3', '', heading), el('p', '', description));
  return wrap;
}
function note(titleText, bodyText, action) {
  const box = el('div', 'dm-note');
  box.append(el('strong', '', titleText), el('p', '', bodyText));
  if (action) box.append(action);
  return box;
}
function toolbar(buttons) {
  const row = el('div', 'dm-actions');
  row.append(...buttons);
  return row;
}
function metric(label, value, detail) {
  const card = el('div', 'dm-metric');
  card.append(el('span', '', label), el('strong', '', value), el('small', '', detail));
  return card;
}
function gameRow(game, row) {
  const card = el('article', 'dm-game');
  const top = el('div', 'dm-game-main');
  const icon = el('div', 'dm-game-icon', (nameOf(game)[0] ?? 'O').toUpperCase());
  const text = el('div', '');
  text.append(el('strong', '', nameOf(game)), el('span', '', 'Sauvegardes ' + formatBytes(row?.profile ?? 0) + '  ·  Cache ' + formatBytes(row?.cache ?? 0)));
  top.append(icon, text);
  const buttons = [];
  if (row?.profile) buttons.push(button('Exporter', () => exportLocal(game), 'dm-primary'));
  buttons.push(button('Importer', () => pickImport(game)));
  if (row?.cache) buttons.push(button('Vider le cache', () => clearCache(game), 'dm-quiet'));
  if (row?.profile) buttons.push(button('Effacer les sauvegardes', () => clearProfile(game), 'dm-danger'));
  const actions = toolbar(buttons);
  card.append(top, actions);
  if (activeGame(game)) card.append(el('small', 'dm-playing', 'Jeu en cours : l’import et le nettoyage seront disponibles après l’avoir quitté.'));
  return card;
}
function renderLocal() {
  content.append(sectionHeading('01 / SUR CET APPAREIL', 'Bibliothèque locale',
    'Les sauvegardes restent dans ce navigateur. Exportez-les pour les garder ailleurs ; le cache du jeu peut être téléchargé à nouveau.'));
  const storage = app.storage;
  if (!storage) return;
  const cards = el('div', 'dm-metrics');
  cards.append(metric('Espace utilisé', formatBytes(storage.usage), storage.quota ? 'sur ' + formatBytes(storage.quota) + ' disponibles' : 'Quota indisponible'),
    metric('Sauvegardes', String(storage.games.filter((g) => g.profile > 0).length), 'jeux avec des données locales'),
    metric('Protection du stockage', storage.persistent ? 'Activée' : 'À activer', storage.persistent ? 'Le navigateur essaiera de conserver les fichiers.' : 'Évite un nettoyage automatique du navigateur.'));
  content.append(cards);
  if (!storage.persistent) content.append(note('Conserver les données locales',
    'Autorisez votre navigateur à protéger le stockage de ce site.',
    button('Demander la conservation', () => run('Demande de conservation', async () =>
      (await navigator.storage.persist()) ? 'Conservation activée.' : 'Le navigateur a refusé la demande.'))));
  const list = el('div', 'dm-list');
  const names = new Set([...app.titles.keys(), ...storage.games.map((g) => g.game)]);
  for (const game of [...names].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) {
    const row = storage.games.find((g) => g.game === game);
    if (!row && !app.titles.has(game)) continue;
    list.append(gameRow(game, row));
  }
  if (!names.size) list.append(note('Aucun jeu', 'Les jeux apparaîtront ici dès que le serveur les proposera.'));
  content.append(list);
  if (storage.asides.length) {
    const aside = el('div', 'dm-asides');
    aside.append(el('h4', '', 'Copies de secours locales'));
    for (const item of storage.asides) {
      const row = el('div', 'dm-aside');
      row.append(el('span', '', item.name + ' · ' + formatBytes(item.bytes)),
        button('Supprimer', () => run('Suppression de la copie', async () => {
          if (!confirm('Supprimer définitivement cette ancienne copie ?')) return 'Annulé.';
          const root = await navigator.storage.getDirectory();
          await root.removeEntry(item.name, { recursive: true });
          return 'Copie supprimée.';
        }), 'dm-danger'));
      aside.append(row);
    }
    content.append(aside);
  }
}
function cloudRow(game) {
  const remote = app.cloud.get(game), local = app.storage?.games.find((g) => g.game === game);
  const card = el('article', 'dm-game');
  const top = el('div', 'dm-game-main');
  const icon = el('div', 'dm-game-icon dm-cloud-icon', (nameOf(game)[0] ?? 'O').toUpperCase());
  const text = el('div', '');
  text.append(el('strong', '', nameOf(game)), el('span', '',
    remote ? 'En ligne : version ' + remote.version + ' · ' + formatBytes(remote.size) + ' · ' + stamp(remote.updatedAt) : 'Aucune copie en ligne'));
  top.append(icon, text);
  const buttons = [];
  if (local?.profile) buttons.push(button('Envoyer maintenant', () => uploadGame(game, true), 'dm-primary'));
  if (remote) {
    buttons.push(button('Restaurer', () => restoreCloud(game)));
    buttons.push(button('Télécharger', () => downloadCloud(game, remote.version), 'dm-quiet'));
    buttons.push(button('Historique', () => toggleHistory(game), 'dm-quiet'));
    buttons.push(button('Effacer en ligne', () => deleteCloud(game), 'dm-danger'));
  }
  card.append(top, toolbar(buttons));
  if (app.expanded === game) {
    const history = el('div', 'dm-history');
    const versions = app.histories.get(game) ?? [];
    for (const v of versions) {
      const row = el('div', 'dm-version');
      row.append(el('span', '', 'Version ' + v.version + ' · ' + stamp(v.createdAt) + ' · ' + formatBytes(v.size)),
        button('Restaurer', () => restoreCloud(game, v.version)),
        button('Télécharger', () => downloadCloud(game, v.version), 'dm-quiet'));
      history.append(row);
    }
    card.append(history);
  }
  return card;
}
function renderCloud() {
  content.append(sectionHeading('02 / SAUVEGARDE EN LIGNE', 'Vos parties vous suivent',
    'Vos jeux tournent toujours ici, dans le navigateur. Seuls leurs profils et sauvegardes sont copiés sur votre compte.'));
  if (!app.account) {
    content.append(note('Un compte, si vous en voulez un',
      'Jouez librement sans compte. Connectez-vous seulement pour conserver une copie de vos parties en ligne.',
      button('Se connecter ou créer un compte', () => { app.tab = 'account'; render(); }, 'dm-primary')));
    return;
  }
  const controls = el('div', 'dm-cloud-controls');
  controls.append(el('p', '', 'Connecté en tant que ' + app.account.username + '. Les copies conservent 20 versions par jeu.'),
    button('Synchroniser les sauvegardes locales', () => run('Synchronisation', syncAll), 'dm-primary'));
  content.append(controls);
  const list = el('div', 'dm-list');
  const names = new Set([...app.cloud.keys(), ...(app.storage?.games ?? []).filter((g) => g.profile > 0).map((g) => g.game)]);
  for (const game of [...names].sort((a, b) => nameOf(a).localeCompare(nameOf(b)))) list.append(cloudRow(game));
  if (!names.size) list.append(note('Aucune sauvegarde pour le moment', 'Lancez un jeu, puis revenez ici pour créer sa première copie.'));
  content.append(list);
  content.append(el('p', 'dm-footnote', 'En cas de différence entre cet appareil et le cloud, rien n’est écrasé automatiquement. Choisissez la version à conserver.'));
}
function labelled(label, type, name, autocomplete) {
  const wrap = el('label', 'dm-field');
  wrap.append(el('span', '', label));
  const input = el('input', '');
  input.type = type; input.name = name; input.required = true; input.autocomplete = autocomplete;
  if (type === 'password') { input.minLength = 10; input.maxLength = 128; }
  wrap.append(input);
  return wrap;
}
function renderAccount() {
  content.append(sectionHeading('03 / COMPTE FACULTATIF', 'Votre espace privé',
    'Aucun compte n’est nécessaire pour jouer ou garder des sauvegardes sur cet appareil.'));
  if (app.account) {
    content.append(note('Connecté : ' + app.account.username, 'Vos sauvegardes en ligne sont accessibles depuis un autre appareil connecté au même compte.',
      button('Se déconnecter', () => run('Déconnexion', async () => {
        await jsonApi('/api/account/logout', 'POST');
        app.account = null; app.cloud.clear(); return 'Déconnecté. Les sauvegardes locales restent sur cet appareil.';
      }), 'dm-danger')));
    const form = el('form', 'dm-form');
    form.append(el('h4', '', 'Changer le mot de passe'),
      labelled('Mot de passe actuel', 'password', 'oldPassword', 'current-password'),
      labelled('Nouveau mot de passe', 'password', 'newPassword', 'new-password'));
    const submit = el('button', 'dm-button dm-primary', 'Modifier le mot de passe'); submit.type = 'submit'; form.append(submit);
    form.onsubmit = (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); run('Modification du mot de passe', async () => {
      await jsonApi('/api/account/password', 'POST', data); form.reset(); return 'Mot de passe modifié.';
    }, false); };
    content.append(form);
    const deletion = el('div', 'dm-account-delete');
    deletion.append(el('strong', '', 'Supprimer le compte'),
      el('p', '', 'Efface toutes les versions sauvegardées en ligne. Les données de cet appareil restent intactes.'),
      button('Supprimer mon compte', () => run('Suppression du compte', async () => {
        const password = prompt('Saisis ton mot de passe pour confirmer la suppression définitive du compte.');
        if (!password) return 'Suppression annulée.';
        if (!confirm('Dernière confirmation : supprimer le compte et toutes ses sauvegardes en ligne ?')) return 'Suppression annulée.';
        await jsonApi('/api/account', 'DELETE', { password });
        app.account = null; app.cloud.clear();
        return 'Compte supprimé. Les sauvegardes locales sont conservées.';
      }), 'dm-danger'));
    content.append(deletion);
    return;
  }
  const switcher = el('div', 'dm-switcher');
  switcher.append(button('Se connecter', () => { app.accountMode = 'login'; render(); }, app.accountMode === 'login' ? 'dm-selected' : ''),
    button('Créer un compte', () => { app.accountMode = 'register'; render(); }, app.accountMode === 'register' ? 'dm-selected' : ''));
  content.append(switcher);
  const form = el('form', 'dm-form');
  form.append(labelled('Identifiant', 'text', 'username', 'username'), labelled('Mot de passe', 'password', 'password',
    app.accountMode === 'login' ? 'current-password' : 'new-password'));
  const submit = el('button', 'dm-button dm-primary', app.accountMode === 'login' ? 'Se connecter' : 'Créer mon compte');
  submit.type = 'submit'; form.append(submit);
  form.onsubmit = (event) => { event.preventDefault(); const data = Object.fromEntries(new FormData(form)); run(
    app.accountMode === 'login' ? 'Connexion' : 'Création du compte', async () => {
      const result = await jsonApi('/api/account/' + app.accountMode, 'POST', data);
      app.account = result.user; app.tab = 'cloud'; form.reset();
      await refresh(); await syncAll(); return 'Compte connecté. Vos données locales restent sur cet appareil.';
    }); };
  content.append(form);
  content.append(el('p', 'dm-footnote', 'Identifiant de 3 à 32 caractères ; mot de passe d’au moins 10 caractères. Conservez-le : la récupération par e-mail n’est pas encore disponible.'));
}
function render() {
  nav.replaceChildren(); content.replaceChildren();
  const tabs = [['local', '◫', 'Sur cet appareil'], ['cloud', '☁', 'En ligne'], ['account', '◎', 'Compte']];
  for (const [id, icon, label] of tabs) {
    const tab = button(icon + '   ' + label, () => { app.tab = id; render(); }, 'dm-tab' + (app.tab === id ? ' dm-active' : ''));
    tab.setAttribute('aria-current', app.tab === id ? 'page' : 'false');
    nav.append(tab);
  }
  const sign = el('div', 'dm-nav-caption', app.account ? 'Connecté : ' + app.account.username : 'Aucun compte requis');
  nav.append(sign);
  if (app.tab === 'local') renderLocal();
  else if (app.tab === 'cloud') renderCloud();
  else renderAccount();
  status.textContent = app.message;
}

async function exportLocal(game) {
  return run('Préparation de la sauvegarde', async () => {
    const bytes = await archiveProfile(game, state());
    if (!bytes) throw new Error('Ce jeu n’a pas encore de sauvegarde locale.');
    download(bytes, game + '-' + new Date().toISOString().slice(0, 10) + '.orthros-save');
    return 'Sauvegarde téléchargée : ' + formatBytes(bytes.length) + '.';
  }, false);
}
const picker = el('input');
picker.type = 'file'; picker.accept = '.orthros-save,.gz'; picker.hidden = true;
document.body.append(picker);
let importGame = null;
function pickImport(game) {
  if (activeGame(game)) { app.message = 'Quitte ce jeu avant d’importer une sauvegarde.'; render(); return; }
  importGame = game; picker.value = ''; picker.click();
}
picker.onchange = () => {
  const file = picker.files?.[0], game = importGame;
  if (!file || !game) return;
  run('Import de la sauvegarde', async () => {
    const archive = await parseArchive(await file.arrayBuffer(), game);
    if (!confirm('Restaurer cette sauvegarde pour ' + nameOf(game) + ' ? Les données actuelles seront conservées dans une copie de secours.')) return 'Import annulé.';
    const aside = await restoreProfile(game, archive, state());
    return 'Sauvegarde restaurée.' + (aside ? ' Une copie des données précédentes a été gardée.' : '');
  });
};
function clearCache(game) {
  return run('Nettoyage du cache', async () => {
    if (!confirm('Effacer le cache de ' + nameOf(game) + ' ? Les fichiers du jeu seront téléchargés de nouveau si nécessaire ; les sauvegardes resteront intactes.')) return 'Annulé.';
    await removeCache(game, state()); return 'Cache effacé, sauvegardes conservées.';
  });
}
function clearProfile(game) {
  return run('Suppression des sauvegardes', async () => {
    if (!confirm('Supprimer définitivement les sauvegardes locales de ' + nameOf(game) + ' ? Exportez-les avant si vous souhaitez les garder.')) return 'Annulé.';
    await removeProfile(game, state()); return 'Sauvegardes locales supprimées.';
  });
}
async function uploadGame(game, force = false) {
  return run('Envoi de la sauvegarde', async () => {
    const bytes = await archiveProfile(game, state());
    if (!bytes) throw new Error('Ce jeu n’a pas de sauvegarde locale.');
    if (bytes.length > 64 * 1024 * 1024) throw new Error('Cette sauvegarde dépasse la limite cloud de 64 Mo. L’export local reste possible.');
    const hash = await hashBytes(bytes), remote = app.cloud.get(game), parent = remote?.hash ?? 'none';
    if (hash === parent) { setKnown(game, hash); return 'Cette sauvegarde est déjà en ligne.'; }
    if (remote && getKnown(game) !== parent && !force)
      throw new Error('La copie en ligne diffère de celle de cet appareil. Choisissez « Envoyer maintenant » ou « Restaurer ».');
    if (remote && force && !confirm('Publier les données de cet appareil comme nouvelle version en ligne ? La version précédente restera dans l’historique.')) return 'Envoi annulé.';
    const response = await api('/api/cloud/' + encodeURIComponent(game), {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Orthros-Parent-Hash': parent }, body: bytes,
    });
    const result = await response.json();
    setKnown(game, result.hash);
    return 'Sauvegarde en ligne créée' + (result.version ? ' (version ' + result.version + ')' : '') + '.';
  });
}
async function syncAll() {
  const rows = (app.storage?.games ?? []).filter((g) => g.profile > 0);
  let uploaded = 0, conflicts = 0;
  for (const row of rows) {
    const game = row.game, bytes = await archiveProfile(game, state());
    if (!bytes || bytes.length > 64 * 1024 * 1024) continue;
    const hash = await hashBytes(bytes), remote = app.cloud.get(game), parent = remote?.hash ?? 'none';
    if (hash === parent) { setKnown(game, hash); continue; }
    if (remote && getKnown(game) !== parent) { conflicts++; continue; }
    try {
      const response = await api('/api/cloud/' + encodeURIComponent(game), {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-Orthros-Parent-Hash': parent }, body: bytes,
      });
      const result = await response.json();
      setKnown(game, result.hash);
      app.cloud.set(game, { game, hash: result.hash, version: result.version ?? remote?.version, size: bytes.length, updatedAt: Date.now() });
      uploaded++;
    } catch (error) { if (error.status === 409) conflicts++; else throw error; }
  }
  return uploaded + ' sauvegarde(s) envoyée(s).' + (conflicts ? ' ' + conflicts + ' conflit(s) à examiner dans l’onglet En ligne.' : '');
}
async function restoreCloud(game, version) {
  return run('Restauration depuis le cloud', async () => {
    if (activeGame(game)) throw new Error('Quitte ce jeu avant de restaurer ses sauvegardes.');
    if (!confirm('Restaurer la sauvegarde en ligne de ' + nameOf(game) + ' ? Les données actuelles seront gardées en copie de secours.')) return 'Restauration annulée.';
    const url = '/api/cloud/' + encodeURIComponent(game) + (version ? '/' + version : '');
    const bytes = new Uint8Array(await (await api(url)).arrayBuffer());
    const archive = await parseArchive(bytes, game);
    const aside = await restoreProfile(game, archive, state());
    const head = app.cloud.get(game);
    if (head) setKnown(game, head.hash);
    return 'Sauvegarde restaurée.' + (aside ? ' L’ancienne copie locale a été conservée.' : '');
  });
}
async function downloadCloud(game, version) {
  return run('Téléchargement de la version', async () => {
    const bytes = new Uint8Array(await (await api('/api/cloud/' + encodeURIComponent(game) + '/' + version)).arrayBuffer());
    download(bytes, game + '-v' + version + '.orthros-save');
    return 'Version ' + version + ' téléchargée.';
  }, false);
}
async function deleteCloud(game) {
  return run('Suppression de la copie en ligne', async () => {
    if (!confirm('Supprimer toutes les versions en ligne de ' + nameOf(game) + ' ? Les sauvegardes présentes sur cet appareil ne seront pas touchées.')) return 'Suppression annulée.';
    await api('/api/cloud/' + encodeURIComponent(game), { method: 'DELETE' });
    localStorage.removeItem(knownKey(game));
    return 'Copies en ligne supprimées. Les données locales restent disponibles.';
  });
}
async function toggleHistory(game) {
  if (app.expanded === game) { app.expanded = null; render(); return; }
  return run('Chargement de l’historique', async () => {
    const result = await jsonApi('/api/cloud/' + encodeURIComponent(game) + '/history');
    app.histories.set(game, result.versions); app.expanded = game;
    return 'Historique chargé.';
  }, false);
}

function open(tab = 'local') {
  if (document.pointerLockElement) document.exitPointerLock();
  app.tab = tab; app.open = true; app.message = ''; render();
  dialog.showModal();
  refresh({ account: true }).catch((error) => { app.message = error.message; render(); });
}
const menuButton = button('◫  Mes données', () => open(), 'dm-entry');
const menuOptions = document.querySelector('#menu .opts');
menuOptions?.insertBefore(menuButton, menuOptions.querySelector('.keys'));
const barButton = button('◫  Mes données', () => open(), 'dm-bar-entry');
document.querySelector('#topbar')?.insertBefore(barButton, document.querySelector('#tbFull'));

setInterval(() => {
  if (app.account && !app.busy) refresh().then(() => syncAll()).then((message) => {
    if (app.open) { app.message = message; render(); }
  }).catch((error) => { if (app.open) { app.message = error.message; render(); } });
}, 5 * 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && app.account && !app.busy)
    refresh().then(syncAll).catch(() => {});
});
