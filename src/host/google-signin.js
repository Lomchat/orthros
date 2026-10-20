// Signing in to the Orthros account with Google: OpenID Connect, authorization code flow with PKCE, all on the server
// (no Google script in the pages — they open a small window on /api/account/google/start). The routes, accounts and
// sessions are in accounts.js; here: the client's settings, Google's addresses, the code exchange, the ID token's
// checks, the username offered to a new player and the small pages the window shows.
// The client: <accounts dir>/google.json, { "clientId": "…", "clientSecret": "…" } — a "Web application" OAuth client
// of the Google Cloud console whose redirect URI is <public origin>/api/account/google/callback. Without it, no button.
import fs from 'node:fs';
import path from 'node:path';

export const GOOGLE = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  issuers: ['https://accounts.google.com', 'accounts.google.com'],
};

/**
 * The Google client of an accounts folder. `override`: settings given directly ({ clientId, clientSecret, auth, token,
 * fetch } — the tests' fake Google); otherwise google.json, read again when it changes (dropped in without a restart).
 */
export function googleClient(dir, override = null) {
  let cached = null, stamp = null;
  const settings = () => {
    if (override) return override;
    const file = path.join(dir, 'google.json');
    let st; try { st = fs.statSync(file); } catch { cached = null; stamp = null; return null; }
    if (stamp !== st.mtimeMs) {
      stamp = st.mtimeMs; cached = null;
      try {
        const c = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof c?.clientId === 'string' && c.clientId && typeof c.clientSecret === 'string' && c.clientSecret) cached = { clientId: c.clientId, clientSecret: c.clientSecret };
        else console.error(`${file}: clientId and clientSecret expected`);
      } catch (e) { console.error(`${file}: ${e.message}`); }
    }
    return cached;
  };
  return {
    enabled: () => !!settings(),
    /** Google's sign-in page for this flow. */
    authUrl({ state, nonce, challenge, redirectUri, lang }) {
      const c = settings();
      const q = new URLSearchParams({ client_id: c.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile',
        state, nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account', hl: lang === 'fr' ? 'fr' : 'en' });
      return `${c.auth ?? GOOGLE.auth}?${q}`;
    },
    /**
     * The code exchanged for the player's identity: the ID token's claims ({ sub, email, email_verified, name, … }), checked
     * (issuer, audience, expiry, nonce). It comes straight from Google's token endpoint over TLS, which stands for its
     * signature (OpenID Connect Core 3.1.3.7).
     */
    async exchange({ code, verifier, redirectUri, nonce }) {
      const c = settings(); if (!c) throw new Error('Google sign-in is not configured');
      const res = await (c.fetch ?? fetch)(c.token ?? GOOGLE.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: c.clientId, client_secret: c.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
        signal: AbortSignal.timeout(15000) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body.id_token !== 'string') throw new Error(`token endpoint: ${res.status} ${body.error ?? ''}`.trim());
      const parts = body.id_token.split('.');
      if (parts.length !== 3) throw new Error('ID token: not a JWT');
      let claims; try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { throw new Error('ID token: unreadable'); }
      const now = Date.now() / 1000;
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!GOOGLE.issuers.includes(claims.iss)) throw new Error('ID token: issuer');
      if (!aud.includes(c.clientId) || (aud.length > 1 && claims.azp !== c.clientId)) throw new Error('ID token: audience');
      if (typeof claims.exp !== 'number' || claims.exp < now - 60) throw new Error('ID token: expired');
      if (claims.nonce !== nonce) throw new Error('ID token: nonce');
      if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new Error('ID token: subject');
      return claims;
    },
  };
}

/** A username for a new player, from their Google name or address, free on this server (`taken(name)`). */
export function suggestUsername(claims, taken) {
  const clean = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9._-]/g, '').replace(/^[._-]+/, '').slice(0, 24);
  const email = typeof claims.email === 'string' ? claims.email.split('@')[0].split('+')[0] : '';
  const base = [clean(email), clean(claims.given_name), clean(claims.name)].find((s) => s.length >= 3) ?? 'joueur';
  if (!taken(base)) return base;
  for (let i = 0; i < 50; i++) {
    const name = `${base.slice(0, 24)}${Math.floor(10 + Math.random() * (i < 20 ? 90 : 9990))}`;
    if (!taken(name)) return name;
  }
  return `joueur${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------- the window's pages
const T = {
  fr: {
    title: 'Connexion avec Google', close: 'Fermer cette fenêtre', back: 'Revenir à Orthros',
    signedIn: (u) => `Connecté en tant que ${u}.`, linked: 'Ton compte Google est maintenant lié à ton compte Orthros.',
    cancelled: 'Connexion avec Google annulée.', expired: 'Cette demande de connexion a expiré ou vient d’un autre navigateur. Recommence depuis Orthros.',
    failed: 'Google n’a pas pu confirmer ton identité. Réessaie dans un instant.', taken: 'Ce compte Google est déjà lié à un autre compte Orthros.',
    hasOther: 'Ton compte Orthros est déjà lié à un autre compte Google.', needSession: 'Connecte-toi d’abord à ton compte Orthros pour y lier Google.',
    welcome: (n) => (n ? `Bienvenue, ${n} !` : 'Bienvenue !'), newLead: 'Choisis ton identifiant Orthros : c’est ton nom dans les parties en ligne. Tu te connecteras ensuite avec Google.',
    username: 'Identifiant', create: 'Créer mon compte', rules: '3 à 32 caractères : lettres minuscules, chiffres, point, tiret ou souligné.',
    haveAccount: 'J’ai déjà un compte Orthros', haveLead: 'Lie Google à ton compte existant : ses sauvegardes restent les mêmes.', password: 'Mot de passe', link: 'Lier et me connecter',
    working: 'Un instant…', error: 'Erreur de connexion.',
  },
  en: {
    title: 'Sign in with Google', close: 'Close this window', back: 'Back to Orthros',
    signedIn: (u) => `Signed in as ${u}.`, linked: 'Your Google account is now linked to your Orthros account.',
    cancelled: 'Google sign-in cancelled.', expired: 'This sign-in request expired or comes from another browser. Start again from Orthros.',
    failed: 'Google could not confirm who you are. Try again in a moment.', taken: 'This Google account is already linked to another Orthros account.',
    hasOther: 'Your Orthros account is already linked to another Google account.', needSession: 'Sign in to your Orthros account first to link Google to it.',
    welcome: (n) => (n ? `Welcome, ${n}!` : 'Welcome!'), newLead: 'Choose your Orthros username: it is your name in online games. You will then sign in with Google.',
    username: 'Username', create: 'Create my account', rules: '3 to 32 characters: lowercase letters, digits, dot, dash or underscore.',
    haveAccount: 'I already have an Orthros account', haveLead: 'Link Google to your existing account: its saves stay the same.', password: 'Password', link: 'Link and sign in',
    working: 'One moment…', error: 'Connection error.',
  },
};
export const pageText = (lang) => T[lang === 'fr' ? 'fr' : 'en'];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
const STYLE = `
:root { color-scheme: dark; } * { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #eceef5;
  background: radial-gradient(70% 50% at 90% 0%, rgba(248,144,31,.13), transparent 70%), linear-gradient(180deg, #0f1528, #080c17); }
main { width: min(420px, 100%); padding: 28px; border-radius: 20px; border: 1px solid #2b3347; background: linear-gradient(180deg, rgba(22,30,52,.92), rgba(14,20,36,.92)); box-shadow: 0 30px 90px rgba(0,0,0,.6); }
.brand { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; } .brand img { width: 44px; height: 45px; }
.brand b { font: 700 13px/1 system-ui; letter-spacing: .32em; color: #ecd9ae; }
h1 { margin: 0 0 8px; font: 700 21px/1.25 "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; color: #f6efdc; }
p { margin: 0 0 16px; color: #9aa3bd; } p.ok { color: #9fe0a6; } p.err { color: #ff9c8f; } p.err:empty { display: none; }
label { display: grid; gap: 6px; margin: 0 0 12px; font-size: 13px; color: #c5cbe0; }
input { font: 15px system-ui, sans-serif; padding: 10px 12px; border-radius: 10px; border: 1px solid #2b3347; background: rgba(0,0,0,.35); color: #fff; }
input:focus, button:focus-visible, summary:focus-visible, a:focus-visible { outline: 2px solid #f8901f; outline-offset: 2px; }
button, a.btn { display: inline-flex; justify-content: center; align-items: center; width: 100%; height: 42px; border-radius: 10px; font: 600 14px system-ui, sans-serif; cursor: pointer; text-decoration: none;
  border: 1px solid rgba(255,190,110,.55); background: linear-gradient(180deg, #ffa445, #f0790f); color: #1a0f05; }
button.ghost, a.btn.ghost { border-color: #2b3347; background: rgba(27,35,64,.7); color: #eceef5; } button:disabled { opacity: .55; cursor: progress; }
small { display: block; margin: -4px 0 14px; color: #7a84a3; font-size: 12.5px; }
details { margin-top: 18px; border-top: 1px solid #1c2440; padding-top: 14px; } summary { cursor: pointer; color: #ffb56b; font-weight: 600; margin-bottom: 10px; }
`;
function page(lang, body, script = '') {
  return `<!doctype html><html lang="${lang === 'fr' ? 'fr' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Orthros — ${esc(pageText(lang).title)}</title><style>${STYLE}</style></head>
<body><main><div class="brand"><img src="/src/host/web/orthros_logo.png" alt=""><b>ORTHROS</b></div>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
}
// (the outcome reaches the page that opened the window — over a channel of the origin: the window's opener is cut off by
// the pages' cross-origin isolation — then the window closes; without a window, the page itself comes back)
const FINISH = `function finish(r){try{const c=new BroadcastChannel('orthros-account');c.postMessage(r);c.close();}catch{}
if(r.popup){if(r.ok)setTimeout(()=>window.close(),500);}else if(r.ok)location.replace(r.back||'/');}`;

/** The window's last page: { result, ok, username?, popup, back, flow } told to the page that opened it. */
export function resultPage(lang, outcome) {
  const S = pageText(lang);
  const text = outcome.result === 'signed-in' ? S.signedIn(outcome.username) : S[outcome.result] ?? S.failed;
  const r = { type: 'google', ...outcome };
  const action = outcome.popup ? `<button type="button" class="ghost" onclick="window.close()">${esc(S.close)}</button>` : `<a class="btn ghost" href="${esc(outcome.back || '/')}">${esc(S.back)}</a>`;
  return page(lang, `<h1>${esc(S.title)}</h1><p class="${outcome.ok ? 'ok' : 'err'}">${esc(text)}</p>${action}`, `${FINISH}finish(${json(r)});`);
}

/** A new player's page: the username to create, or an existing Orthros account to link Google to. */
export function choosePage(lang, { name, email, suggestion, popup, back, flow }) {
  const S = pageText(lang);
  const body = `<h1>${esc(S.welcome(name))}</h1><p>${esc(S.newLead)}${email ? `<br><b style="color:#ecd9ae">${esc(email)}</b>` : ''}</p>
<form id="create"><label>${esc(S.username)}<input name="username" required minlength="3" maxlength="32" autocomplete="username" value="${esc(suggestion)}" autofocus></label>
<small>${esc(S.rules)}</small><button type="submit">${esc(S.create)}</button><p class="err" role="alert"></p></form>
<details><summary>${esc(S.haveAccount)}</summary><p>${esc(S.haveLead)}</p><form id="existing">
<label>${esc(S.username)}<input name="username" required minlength="3" maxlength="32" autocomplete="username"></label>
<label>${esc(S.password)}<input name="password" type="password" required maxlength="128" autocomplete="current-password"></label>
<button type="submit" class="ghost">${esc(S.link)}</button><p class="err" role="alert"></p></form></details>`;
  const script = `${FINISH}const ctx=${json({ popup, back, flow, working: S.working, error: S.error })};
for(const f of document.querySelectorAll('form'))f.onsubmit=async(e)=>{e.preventDefault();const b=f.querySelector('button'),err=f.querySelector('.err'),label=b.textContent;
b.disabled=true;b.textContent=ctx.working;err.textContent='';
try{const res=await fetch('/api/account/google/complete',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
body:JSON.stringify({mode:f.id,...Object.fromEntries(new FormData(f))})});const v=await res.json().catch(()=>({}));
if(!res.ok){err.textContent=v.error||ctx.error;return;}
document.querySelector('main').innerHTML='<h1></h1><p class="ok"></p>';document.querySelector('h1').textContent=v.title;document.querySelector('p').textContent=v.message;
finish({type:'google',result:'signed-in',ok:true,username:v.user.username,popup:ctx.popup,back:ctx.back,flow:ctx.flow});}
catch{err.textContent=ctx.error;}finally{b.disabled=false;b.textContent=label;}};`;
  return page(lang, body, script);
}
