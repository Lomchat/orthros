// The Orthros account: the only identity of a player, on the home screen and on every game page (Windows games,
// browser ports). Who is signed in, signing in / up / out, and the accounts API's messages in the page's language.
// (The API itself: src/host/accounts.js; it answers in French, translated here for the English pages.)

const ERR_EN = {
  'Origine refusée.': 'Origin refused.', 'Origine requise.': 'Origin required.', 'Trop de tentatives. Réessaie plus tard.': 'Too many attempts. Try again later.', 'Trop de tentatives.': 'Too many attempts.',
  'Identifiant : 3 à 32 caractères, lettres, chiffres, point, tiret ou souligné.': 'Username: 3 to 32 characters, letters, digits, dot, dash or underscore.',
  'Le mot de passe doit contenir de 10 à 128 caractères.': 'The password must be 10 to 128 characters long.', 'Cet identifiant est déjà pris.': 'This username is already taken.',
  'Identifiant ou mot de passe incorrect.': 'Wrong username or password.', 'Connexion requise.': 'Sign-in required.', 'Le nouveau mot de passe doit contenir de 10 à 128 caractères.': 'The new password must be 10 to 128 characters long.',
  'Mot de passe actuel incorrect.': 'Current password is wrong.', 'Mot de passe incorrect.': 'Wrong password.', 'Introuvable.': 'Not found.', 'Jeu introuvable.': 'Game not found.', 'Sauvegarde introuvable.': 'Save not found.',
  'Trop d’envois. Réessaie dans une minute.': 'Too many uploads. Try again in a minute.', 'Version de départ invalide.': 'Invalid starting version.', 'Sauvegarde trop volumineuse.': 'Save too large.',
  'Fichier de sauvegarde invalide.': 'Invalid save file.', 'Contenu de sauvegarde invalide.': 'Invalid save content.', 'Une autre sauvegarde existe en ligne.': 'Another save exists online.',
  'Espace cloud plein (512 Mo). Supprime une ancienne copie en ligne.': 'Cloud space full (512 MB). Delete an old online copy.', 'L’espace cloud du site est plein.': 'The site’s cloud space is full.', 'Méthode refusée.': 'Method not allowed.',
  'Le compte actif a changé. Relance le jeu depuis ton compte.': 'The signed-in account changed. Start the game again from your account.',
  'Crée un compte Orthros ou connecte-toi pour jouer en multijoueur.': 'Create an Orthros account or sign in to play multiplayer.',
};
/** A message of the accounts API in language `lang` (the API's own text is French). */
export const errorText = (message, lang) => (lang === 'fr' ? message : ERR_EN[message] ?? message);

/** An answer of the accounts API: its JSON, or an Error carrying its message (in `lang`) and HTTP status. */
export async function accountFetch(path, { method = 'GET', body, lang = 'en', headers = {} } = {}) {
  let response;
  try {
    response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', ...headers } : headers, body: body ? JSON.stringify(body) : undefined });
  } catch { const e = new Error(lang === 'fr' ? 'Erreur de connexion.' : 'Connection error.'); e.status = 0; throw e; }
  if (!response.ok) {
    let message = null; try { message = (await response.json()).error; } catch { /* not JSON */ }
    const e = new Error(errorText(message, lang) || (lang === 'fr' ? 'Erreur de connexion.' : 'Connection error.')); e.status = response.status; throw e;
  }
  return response.json();
}

let current = null;
const listeners = new Set();
/**
 * The server's accounts and who is signed in: { accounts: whether this server has accounts, user: { username } | null }.
 * Asked once per page (`fresh`: asked again).
 */
export function accountState({ fresh = false } = {}) {
  if (!current || fresh) {
    current = (async () => {
      const config = await fetch('/api/config', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
      if (!config.accounts) return { accounts: false, user: null };
      try { return { accounts: true, user: (await accountFetch('/api/account')).user ?? null }; } catch { return { accounts: true, user: null }; }
    })();
  }
  return current;
}
/** Told of every sign-in and sign-out made on this page: fn({ accounts, user }). Returns the unsubscribe. */
export function onAccountChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed(user) {
  current = Promise.resolve({ accounts: true, user });
  for (const fn of listeners) { try { fn({ accounts: true, user }); } catch (e) { console.error(e); } }
  return user;
}
/** Sign in (`mode` 'login') or create the account ('register'); resolves to the user, rejects with a readable Error. */
export async function signIn(mode, username, password, lang = 'en') {
  const result = await accountFetch('/api/account/' + (mode === 'register' ? 'register' : 'login'), { method: 'POST', body: { username, password }, lang });
  return changed(result.user);
}
export async function signOut(lang = 'en') {
  await accountFetch('/api/account/logout', { method: 'POST', lang });
  changed(null);
}
/** Signed in or out elsewhere on this page (the data window): the listeners told. */
export const accountChanged = (user) => changed(user);
