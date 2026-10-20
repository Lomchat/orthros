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
  'Saisis ton identifiant pour confirmer.': 'Type your username to confirm.', 'Connexion avec Google indisponible.': 'Google sign-in is unavailable.',
  'Définis d’abord un mot de passe : sans Google, ce sera ta seule façon de te connecter.': 'Set a password first: without Google, it will be your only way to sign in.',
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

let current = null, google = false;
const listeners = new Set();
/**
 * The server's accounts and who is signed in: { accounts: whether this server has accounts, google: whether it signs in
 * with Google, user: { username, google: address | true | null, password: whether one is set } | null }.
 * Asked once per page (`fresh`: asked again).
 */
export function accountState({ fresh = false } = {}) {
  if (!current || fresh) {
    current = (async () => {
      const config = await fetch('/api/config', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
      if (!config.accounts) return { accounts: false, google: false, user: null };
      google = !!config.google;
      try { return { accounts: true, google, user: (await accountFetch('/api/account')).user ?? null }; } catch { return { accounts: true, google, user: null }; }
    })();
  }
  return current;
}
/** Told of every sign-in and sign-out made on this page: fn({ accounts, user }). Returns the unsubscribe. */
export function onAccountChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed(user) {
  current = Promise.resolve({ accounts: true, google, user });
  for (const fn of listeners) { try { fn({ accounts: true, google, user }); } catch (e) { console.error(e); } }
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
/**
 * Sign in or create the account with Google (`link`: Google added to the signed-in account), in a small window: the page
 * keeps running, the window tells its outcome over a channel of the origin (its opener is cut off by the pages'
 * cross-origin isolation) and closes. A blocked window: the whole page goes to Google and comes back.
 * Resolves to the outcome: { result: 'signed-in' | 'linked' | 'cancelled' | 'taken' | 'hasOther' | 'failed' | …, ok, username? }
 * — never when the player just closes the window.
 */
export function googleSignIn(lang = 'en', { link = false } = {}) {
  const flow = Math.random().toString(36).slice(2, 12).padEnd(8, '0');
  const q = new URLSearchParams({ lang, flow, ...(link ? { link: '1' } : {}) });
  const w = 480, ht = 680, left = Math.max(0, screenX + (outerWidth - w) / 2), top = Math.max(0, screenY + (outerHeight - ht) / 2);
  const channel = new BroadcastChannel('orthros-account');
  const win = window.open(`/api/account/google/start?${q}&popup=1`, 'orthros-google', `popup,width=${w},height=${ht},left=${Math.round(left)},top=${Math.round(top)}`);
  if (!win) { channel.close(); location.assign(`/api/account/google/start?${q}&back=${encodeURIComponent(location.pathname + location.search)}`); return new Promise(() => {}); }
  return new Promise((resolve) => {
    channel.onmessage = async (e) => {
      if (e.data?.type !== 'google' || e.data.flow !== flow) return;
      channel.close();
      if (e.data.ok) { const st = await accountState({ fresh: true }); changed(st.user); }
      resolve(e.data);
    };
  });
}
/** What a Google outcome says to the player, in `lang`. */
export function googleText(outcome, lang) {
  const fr = lang === 'fr';
  const T = { cancelled: fr ? 'Connexion avec Google annulée.' : 'Google sign-in cancelled.', taken: fr ? 'Ce compte Google est déjà lié à un autre compte Orthros.' : 'This Google account is already linked to another Orthros account.',
    hasOther: fr ? 'Ton compte Orthros est déjà lié à un autre compte Google.' : 'Your Orthros account is already linked to another Google account.',
    linked: fr ? 'Compte Google lié.' : 'Google account linked.', expired: fr ? 'La demande a expiré. Recommence.' : 'The request expired. Try again.' };
  return T[outcome.result] ?? (fr ? 'Google n’a pas pu confirmer ton identité. Réessaie.' : 'Google could not confirm who you are. Try again.');
}
/** The Google « G », for the buttons (Google's sign-in branding). */
export const GOOGLE_G = '<svg viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
/** Signed in or out elsewhere on this page (the data window): the listeners told. */
export const accountChanged = (user) => changed(user);
