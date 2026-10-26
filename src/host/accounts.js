// Optional accounts and versioned cloud backups for the browser runtime.
// Browser ports can also use the session resolver for their multiplayer identity.
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { googleClient, suggestUsername, resultPage, choosePage, pageText } from './google-signin.js';

const scrypt = promisify(scryptCallback);
const COOKIE = 'orthros_session';
const OAUTH_COOKIE = 'orthros_oauth', SIGNUP_COOKIE = 'orthros_google'; // (a Google sign-in under way; a new player choosing a name)
const FLOW_MS = 10 * 60 * 1000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BACKUP = 64 * 1024 * 1024;
const MAX_HISTORY = 20;
const MAX_USER_BYTES = 512 * 1024 * 1024;
const MAX_SITE_BYTES = 8 * 1024 * 1024 * 1024;
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const GAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const DEFAULT_ORIGIN = 'https://orthros.chalco.website';

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function reply(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}
function cookie(token, secure, maxAge = Math.floor(SESSION_MS / 1000)) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function requestToken(req, name = COOKIE) {
  const raw = req.headers.cookie?.split(';').map((x) => x.trim()).find((x) => x.startsWith(`${name}=`));
  const token = raw?.slice(name.length + 1) ?? '';
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
function html(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', ...headers });
  res.end(body);
}
/** A page's own address to come back to (a path of this site), or the home screen. */
const backPath = (value) => (typeof value === 'string' && value.length <= 2048 && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : '/');
function sendBytes(res, row) {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': row.data.length,
    'Cache-Control': 'private, no-store', 'X-Orthros-Backup-Hash': row.hash,
    'Content-Disposition': `attachment; filename="${row.game_id}-v${row.version}.orthros-save"` });
  res.end(row.data);
}
async function readBody(req, max) {
  const chunks = []; let n = 0;
  for await (const chunk of req) {
    n += chunk.length;
    if (n > max) { const error = new Error('too large'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
}
function validBackup(bytes, game) {
  try {
    const raw = gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
    const data = JSON.parse(raw.toString('utf8'));
    if (data?.format !== 'orthros-profile' || data.version !== 1 || data.game !== game ||
        !Array.isArray(data.files) || data.files.length > 10000) return false;
    const seen = new Set();
    for (const file of data.files) {
      if (typeof file.path !== 'string' || !file.path || file.path.length > 1024 ||
          file.path.startsWith('/') || file.path.includes('\\') ||
          file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
          typeof file.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data) ||
          (file.mtime !== undefined && !Number.isFinite(file.mtime)) ||
          seen.has(file.path)) return false;
      seen.add(file.path);
    }
    return true;
  } catch { return false; }
}

export function createAccountApi(dir, { publicOrigin = DEFAULT_ORIGIN, allowedGame = () => true, maxUserBytes = MAX_USER_BYTES, google: googleSettings = null } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dir, 'accounts.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS port_tokens (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      installation TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL,
      size INTEGER NOT NULL, created_at INTEGER NOT NULL, data BLOB NOT NULL,
      UNIQUE(user_id, game_id, version)
    );
    CREATE INDEX IF NOT EXISTS backups_latest ON backups(user_id, game_id, version DESC);
    -- (other ways to sign in to an account: Google, its subject; an account made with Google has no password, '')
    CREATE TABLE IF NOT EXISTS identities (
      provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(provider, subject)
    );
    CREATE INDEX IF NOT EXISTS identities_user ON identities(user_id);
  `);
  const google = googleClient(dir, googleSettings);
  const redirectUri = `${publicOrigin}/api/account/google/callback`;
  const flows = new Map(), signups = new Map(); // (Google sign-ins under way: by state; new players choosing a name: by cookie)
  const keep = (map, key, value) => {
    const now = Date.now();
    if (map.size > 500) for (const [k, v] of map) if (v.expires <= now) map.delete(k);
    if (map.size > 2000) map.delete(map.keys().next().value);
    map.set(key, { ...value, expires: now + FLOW_MS });
  };
  const take = (map, key) => { const v = key ? map.get(key) : null; if (key) map.delete(key); return v && v.expires > Date.now() ? v : null; };
  const allowedOrigins = new Set([publicOrigin]);
  const limits = new Map();
  const sessionStmt = db.prepare(`SELECT u.id, u.username FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`);
  function session(req) {
    const token = requestToken(req);
    return token ? sessionStmt.get(sha256(token), Date.now()) : null;
  }
  function limited(req, action, max, windowMs) {
    const now = Date.now(), key = `${clientIp(req)}:${action}`;
    const rec = limits.get(key);
    if (!rec || now >= rec.until) { limits.set(key, { count: 1, until: now + windowMs }); return false; }
    rec.count++;
    if (limits.size > 10000) for (const [k, v] of limits) if (v.until <= now) limits.delete(k);
    return rec.count > max;
  }
  async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
    const hash = await scrypt(password, Buffer.from(salt, 'hex'), 64);
    return `${salt}:${hash.toString('hex')}`;
  }
  async function verifyPassword(password, stored) {
    if (!stored) { await passwordHash('no-password'); return false; } // (an account made with Google: no password yet)
    const [salt, expected] = stored.split(':');
    const hash = await passwordHash(password, salt);
    return timingSafeEqual(Buffer.from(hash.split(':')[1], 'hex'), Buffer.from(expected, 'hex'));
  }
  async function jsonBody(req) {
    const bytes = await readBody(req, 4096);
    try { return JSON.parse(bytes.toString('utf8')); } catch { return null; }
  }
  /** What a page knows of its player: the name, the Google address linked (or null), whether a password is set. */
  function publicUser(user) {
    const g = db.prepare("SELECT email FROM identities WHERE user_id=? AND provider='google'").get(user.id);
    const record = db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
    return { username: user.username, google: g ? g.email || true : null, password: !!record?.password_hash };
  }
  /** A new session's cookies (and the older /api-scoped one cleared). */
  function sessionCookies(user, secure) {
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
      .run(sha256(token), user.id, Date.now() + SESSION_MS);
    return [cookie(token, secure), `${COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`];
  }
  function signIn(res, user, secure) {
    reply(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookies(user, secure) });
  }
  const flowCookie = (name, value, secure, sameSite, maxAge = FLOW_MS / 1000) =>
    `${name}=${value}; Path=/api/account/google; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const linkGoogle = (userId, { sub, email }) => db.prepare("INSERT INTO identities(provider,subject,user_id,email,created_at) VALUES('google',?,?,?,?)")
    .run(sub, userId, typeof email === 'string' ? email.slice(0, 320) : null, Date.now());

  // ---------------------------------------------------------------- Google (google-signin.js)
  // start: the window goes to Google, a cookie binding the flow to this browser; callback: the player known — signed
  // in —, Google added to the signed-in account (link), or a new player choosing a name (complete: a new account, or an
  // existing one with its password); unlink: an account with a password only.
  const SAY_EN = { 'Trop de tentatives. Réessaie plus tard.': 'Too many attempts. Try again later.', 'Identifiant ou mot de passe incorrect.': 'Wrong username or password.',
    'Identifiant : 3 à 32 caractères, lettres, chiffres, point, tiret ou souligné.': 'Username: 3 to 32 characters, letters, digits, dot, dash or underscore.', 'Cet identifiant est déjà pris.': 'This username is already taken.' };
  async function googleRoute(req, res, url, secure) {
    const p = url.pathname, webSecure = publicOrigin.startsWith('https:');
    if (p === '/api/account/google/unlink' && req.method === 'POST') {
      const user = session(req); if (!user) return reply(res, 401, { error: 'Connexion requise.' });
      if (!publicUser(user).password) return reply(res, 409, { error: 'Définis d’abord un mot de passe : sans Google, ce sera ta seule façon de te connecter.' });
      db.prepare("DELETE FROM identities WHERE provider='google' AND user_id=?").run(user.id);
      return reply(res, 200, { user: publicUser(user) });
    }
    if (!google.enabled()) return reply(res, 404, { error: 'Connexion avec Google indisponible.' });
    const browserLang = /^fr\b/i.test(String(req.headers['accept-language'] ?? '')) ? 'fr' : 'en';
    if (p === '/api/account/google/start' && req.method === 'GET') {
      const q = url.searchParams, lang = q.get('lang') === 'fr' || q.get('lang') === 'en' ? q.get('lang') : browserLang;
      const ctx = { popup: q.get('popup') === '1', back: backPath(q.get('back')), flow: /^[a-z0-9]{8,32}$/.test(q.get('flow') ?? '') ? q.get('flow') : null };
      if (limited(req, 'google', 30, 10 * 60_000)) return html(res, 429, resultPage(lang, { ...ctx, result: 'failed', ok: false }));
      let link = null;
      if (q.get('link') === '1') {
        const user = session(req); if (!user) return html(res, 401, resultPage(lang, { ...ctx, result: 'needSession', ok: false }));
        link = user.id;
      }
      const state = randomBytes(24).toString('hex'), binding = randomBytes(32).toString('hex'), verifier = randomBytes(32).toString('base64url'), nonce = randomBytes(16).toString('hex');
      keep(flows, state, { binding: sha256(binding), verifier, nonce, link, lang, ...ctx });
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      // (Lax: the cookie comes back with Google's redirection, a navigation from another site)
      res.writeHead(302, { Location: google.authUrl({ state, nonce, challenge, redirectUri, lang }), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        'Set-Cookie': flowCookie(OAUTH_COOKIE, binding, webSecure, 'Lax') });
      return res.end();
    }
    if (p === '/api/account/google/callback' && req.method === 'GET') {
      const q = url.searchParams, state = q.get('state') ?? '';
      const st = take(flows, /^[a-f0-9]{48}$/.test(state) ? state : null), binding = requestToken(req, OAUTH_COOKIE), lang = st?.lang ?? browserLang;
      const ctx = { popup: !!st?.popup, back: st?.back ?? '/', flow: st?.flow ?? null };
      const clear = flowCookie(OAUTH_COOKIE, '', webSecure, 'Lax', 0);
      const done = (status, outcome, cookies = []) => html(res, status, resultPage(lang, { ...ctx, ...outcome }), { 'Set-Cookie': [clear, ...cookies] });
      if (!st || !binding || sha256(binding) !== st.binding) return done(400, { result: 'expired', ok: false });
      if (q.get('error')) return done(200, { result: 'cancelled', ok: false });
      let claims;
      try { claims = await google.exchange({ code: q.get('code') ?? '', verifier: st.verifier, redirectUri, nonce: st.nonce }); }
      catch (e) { console.error('Google sign-in:', e.message); return done(502, { result: 'failed', ok: false }); }
      const email = typeof claims.email === 'string' ? claims.email.slice(0, 320) : null;
      const known = db.prepare("SELECT user_id FROM identities WHERE provider='google' AND subject=?").get(claims.sub);
      if (known) db.prepare("UPDATE identities SET email=? WHERE provider='google' AND subject=?").run(email, claims.sub);
      if (st.link) {
        if (known && known.user_id !== st.link) return done(409, { result: 'taken', ok: false });
        if (!known) {
          if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(st.link)) return done(400, { result: 'expired', ok: false });
          if (db.prepare("SELECT 1 FROM identities WHERE provider='google' AND user_id=?").get(st.link)) return done(409, { result: 'hasOther', ok: false });
          linkGoogle(st.link, claims);
        }
        return done(200, { result: 'linked', ok: true });
      }
      if (known) {
        const user = db.prepare('SELECT id, username FROM users WHERE id=?').get(known.user_id);
        return done(200, { result: 'signed-in', ok: true, username: user.username }, sessionCookies(user, webSecure));
      }
      const token = randomBytes(32).toString('hex');
      keep(signups, sha256(token), { sub: claims.sub, email, lang, ...ctx });
      const suggestion = suggestUsername(claims, (name) => !!db.prepare('SELECT 1 FROM users WHERE username=?').get(name));
      return html(res, 200, choosePage(lang, { name: typeof claims.given_name === 'string' ? claims.given_name.slice(0, 64) : '', email, suggestion, ...ctx }),
        { 'Set-Cookie': [clear, flowCookie(SIGNUP_COOKIE, token, webSecure, 'Strict')] });
    }
    if (p === '/api/account/google/complete' && req.method === 'POST') {
      const token = requestToken(req, SIGNUP_COOKIE), key = token ? sha256(token) : null, pending = key ? signups.get(key) : null;
      const S = pageText(pending?.lang ?? browserLang), say = (fr) => (pending?.lang === 'fr' ? fr : SAY_EN[fr] ?? fr);
      if (!pending || pending.expires <= Date.now()) return reply(res, 400, { error: S.expired });
      const body = await jsonBody(req), username = String(body?.username ?? '').trim().toLowerCase();
      let user, created = false;
      if (body?.mode === 'existing') {
        if (limited(req, 'login', 10, 60_000)) return reply(res, 429, { error: say('Trop de tentatives. Réessaie plus tard.') });
        const record = USERNAME.test(username) ? db.prepare('SELECT * FROM users WHERE username=?').get(username) : null;
        const valid = typeof body.password === 'string' && body.password.length <= 128 && await verifyPassword(body.password, record?.password_hash ?? await passwordHash('invalid-password'));
        if (!record || !valid) return reply(res, 401, { error: say('Identifiant ou mot de passe incorrect.') });
        user = { id: record.id, username: record.username };
      } else {
        if (limited(req, 'register', 5, 15 * 60_000)) return reply(res, 429, { error: say('Trop de tentatives. Réessaie plus tard.') });
        if (!USERNAME.test(username)) return reply(res, 400, { error: say('Identifiant : 3 à 32 caractères, lettres, chiffres, point, tiret ou souligné.') });
        user = { id: randomUUID(), username }; created = true;
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        if (db.prepare("SELECT 1 FROM identities WHERE provider='google' AND subject=?").get(pending.sub)) { db.exec('ROLLBACK'); signups.delete(key); return reply(res, 409, { error: S.taken }); }
        if (!created && db.prepare("SELECT 1 FROM identities WHERE provider='google' AND user_id=?").get(user.id)) { db.exec('ROLLBACK'); return reply(res, 409, { error: S.hasOther }); }
        if (created && db.prepare('SELECT 1 FROM users WHERE username=?').get(username)) { db.exec('ROLLBACK'); return reply(res, 409, { error: say('Cet identifiant est déjà pris.') }); }
        if (created) db.prepare('INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)').run(user.id, username, '', Date.now());
        linkGoogle(user.id, pending);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      signups.delete(key);
      return reply(res, 200, { user: publicUser(user), title: S.title, message: S.signedIn(user.username) },
        { 'Set-Cookie': [...sessionCookies(user, secure), flowCookie(SIGNUP_COOKIE, '', secure, 'Strict', 0)] });
    }
    return reply(res, 404, { error: 'Introuvable.' });
  }

  const api = async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (req.method !== 'GET' && req.headers.origin &&
        !allowedOrigins.has(req.headers.origin) && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(req.headers.origin))
      return reply(res, 403, { error: 'Origine refusée.' });
    if (req.method !== 'GET' && !req.headers.origin) return reply(res, 403, { error: 'Origine requise.' });
    const secure = req.headers.origin?.startsWith('https:') || req.headers['x-forwarded-proto'] === 'https';
    if (p === '/api/account' && req.method === 'GET') {
      const user = session(req);
      // Migrate older cookies scoped to /api before entering a browser port.
      const token = requestToken(req);
      return reply(res, 200, { user: user ? publicUser(user) : null }, user ? { 'Set-Cookie': [cookie(token, secure), `${COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`] } : {});
    }
    if (p.startsWith('/api/account/google/')) return googleRoute(req, res, url, secure);
    if (p === '/api/account/register' && req.method === 'POST') {
      if (limited(req, 'register', 5, 15 * 60_000)) return reply(res, 429, { error: 'Trop de tentatives. Réessaie plus tard.' });
      const body = await jsonBody(req), username = String(body?.username ?? '').trim().toLowerCase(), password = body?.password;
      if (!USERNAME.test(username)) return reply(res, 400, { error: 'Identifiant : 3 à 32 caractères, lettres, chiffres, point, tiret ou souligné.' });
      if (typeof password !== 'string' || password.length < 10 || password.length > 128) return reply(res, 400, { error: 'Le mot de passe doit contenir de 10 à 128 caractères.' });
      const hash = await passwordHash(password), user = { id: randomUUID(), username };
      try { db.prepare('INSERT INTO users(id,username,password_hash,created_at) VALUES(?,?,?,?)').run(user.id, username, hash, Date.now()); }
      catch (e) { if (e.code === 'ERR_SQLITE_ERROR' || String(e).includes('UNIQUE')) return reply(res, 409, { error: 'Cet identifiant est déjà pris.' }); throw e; }
      return signIn(res, user, secure);
    }
    if (p === '/api/account/login' && req.method === 'POST') {
      if (limited(req, 'login', 10, 60_000)) return reply(res, 429, { error: 'Trop de tentatives. Réessaie plus tard.' });
      const body = await jsonBody(req), username = String(body?.username ?? '').trim().toLowerCase(), password = body?.password;
      const user = USERNAME.test(username) ? db.prepare('SELECT * FROM users WHERE username=?').get(username) : null;
      const valid = typeof password === 'string' && password.length <= 128 && await verifyPassword(password, user?.password_hash ?? await passwordHash('invalid-password'));
      if (!user || !valid) return reply(res, 401, { error: 'Identifiant ou mot de passe incorrect.' });
      return signIn(res, user, secure);
    }
    if (p === '/api/account/logout' && req.method === 'POST') {
      const token = requestToken(req);
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(token));
      return reply(res, 200, { ok: true }, { 'Set-Cookie': [cookie('', secure, 0), `${COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`] });
    }
    if (p === '/api/account/password' && req.method === 'POST') {
      const user = session(req); if (!user) return reply(res, 401, { error: 'Connexion requise.' });
      if (limited(req, 'password', 5, 15 * 60_000)) return reply(res, 429, { error: 'Trop de tentatives.' });
      const body = await jsonBody(req), oldPassword = body?.oldPassword, newPassword = body?.newPassword;
      if (typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 128) return reply(res, 400, { error: 'Le nouveau mot de passe doit contenir de 10 à 128 caractères.' });
      const record = db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
      // (an account made with Google sets its first password without one)
      if (!record || (record.password_hash && (typeof oldPassword !== 'string' || !await verifyPassword(oldPassword, record.password_hash)))) return reply(res, 403, { error: 'Mot de passe actuel incorrect.' });
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await passwordHash(newPassword), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(user.id, sha256(requestToken(req)));
      return reply(res, 200, { ok: true });
    }
    if (p === '/api/account' && req.method === 'DELETE') {
      const user = session(req); if (!user) return reply(res, 401, { error: 'Connexion requise.' });
      const body = await jsonBody(req);
      const record = db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
      if (!record) return reply(res, 403, { error: 'Mot de passe incorrect.' });
      // (without a password — an account made with Google — its name typed again confirms)
      if (!record.password_hash ? body?.username !== user.username : typeof body?.password !== 'string' || !await verifyPassword(body.password, record.password_hash))
        return reply(res, 403, { error: record.password_hash ? 'Mot de passe incorrect.' : 'Saisis ton identifiant pour confirmer.' });
      db.prepare('DELETE FROM users WHERE id=?').run(user.id);
      return reply(res, 200, { ok: true }, { 'Set-Cookie': [cookie('', secure, 0), `${COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`] });
    }
    if (!p.startsWith('/api/cloud')) return reply(res, 404, { error: 'Introuvable.' });
    const user = session(req); if (!user) return reply(res, 401, { error: 'Connexion requise.' });
    const scope = req.headers['x-orthros-player-scope'];
    if (scope && scope !== sha256(user.id).slice(0, 24)) return reply(res, 401, { error: 'Le compte actif a changé. Relance le jeu depuis ton compte.' });
    if (p === '/api/cloud' && req.method === 'GET') {
      const rows = db.prepare(`SELECT b.game_id game, b.version, b.hash, b.size, b.created_at updatedAt
        FROM backups b JOIN (SELECT game_id, MAX(version) version FROM backups WHERE user_id=? GROUP BY game_id) h
        ON h.game_id=b.game_id AND h.version=b.version WHERE b.user_id=? ORDER BY b.game_id`).all(user.id, user.id);
      return reply(res, 200, { games: rows });
    }
    const m = /^\/api\/cloud\/([^/]+)(?:\/(history|[0-9]+))?$/.exec(p);
    if (!m || !GAME.test(m[1]) || !allowedGame(m[1])) return reply(res, 404, { error: 'Jeu introuvable.' });
    const game = m[1], tail = m[2];
    if (req.method === 'GET' && tail === 'history') {
      const rows = db.prepare('SELECT version,hash,size,created_at createdAt FROM backups WHERE user_id=? AND game_id=? ORDER BY version DESC LIMIT 20').all(user.id, game);
      return reply(res, 200, { versions: rows });
    }
    if (req.method === 'GET') {
      const row = tail ? db.prepare('SELECT * FROM backups WHERE user_id=? AND game_id=? AND version=?').get(user.id, game, Number(tail))
        : db.prepare('SELECT * FROM backups WHERE user_id=? AND game_id=? ORDER BY version DESC LIMIT 1').get(user.id, game);
      return row ? sendBytes(res, row) : reply(res, 404, { error: 'Sauvegarde introuvable.' });
    }
    if (req.method === 'DELETE' && !tail) {
      db.prepare('DELETE FROM backups WHERE user_id=? AND game_id=?').run(user.id, game);
      return reply(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && !tail) {
      if (limited(req, 'upload', 20, 60_000)) return reply(res, 429, { error: 'Trop d’envois. Réessaie dans une minute.' });
      const parent = String(req.headers['x-orthros-parent-hash'] ?? '');
      if (parent !== 'none' && !HASH.test(parent)) return reply(res, 400, { error: 'Version de départ invalide.' });
      if (Number(req.headers['content-length'] ?? 0) > MAX_BACKUP) return reply(res, 413, { error: 'Sauvegarde trop volumineuse.' });
      const bytes = await readBody(req, MAX_BACKUP);
      if (bytes.length < 20 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return reply(res, 400, { error: 'Fichier de sauvegarde invalide.' });
      if (!validBackup(bytes, game)) return reply(res, 400, { error: 'Contenu de sauvegarde invalide.' });
      const hash = sha256(bytes);
      db.exec('BEGIN IMMEDIATE');
      try {
        const head = db.prepare('SELECT hash,version FROM backups WHERE user_id=? AND game_id=? ORDER BY version DESC LIMIT 1').get(user.id, game);
        const actual = head?.hash ?? 'none';
        if (actual !== parent) { db.exec('ROLLBACK'); return reply(res, 409, { error: 'Une autre sauvegarde existe en ligne.', remoteHash: actual }); }
        if (actual === hash) { db.exec('ROLLBACK'); return reply(res, 200, { hash, unchanged: true }); }
        const version = (head?.version ?? 0) + 1;
        let bytesUsed = db.prepare('SELECT COALESCE(SUM(size),0) total FROM backups WHERE user_id=?').get(user.id).total;
        // (over the account's space: its oldest versions go first — never a game's latest — before the upload is refused;
        // the saves are sent automatically while playing, the history is the part that can give way)
        if (bytesUsed + bytes.length > maxUserBytes) {
          const old = db.prepare(`SELECT b.id, b.size FROM backups b WHERE b.user_id=? AND b.version < (SELECT MAX(version) FROM backups x WHERE x.user_id=b.user_id AND x.game_id=b.game_id) ORDER BY b.created_at`).all(user.id);
          for (const row of old) {
            if (bytesUsed + bytes.length <= maxUserBytes) break;
            db.prepare('DELETE FROM backups WHERE id=?').run(row.id); bytesUsed -= row.size;
          }
        }
        if (bytesUsed + bytes.length > maxUserBytes) { db.exec('ROLLBACK'); return reply(res, 413, { error: 'Espace cloud plein (512 Mo). Supprime une ancienne copie en ligne.' }); }
        const siteBytes = db.prepare('SELECT COALESCE(SUM(size),0) total FROM backups').get().total;
        if (siteBytes + bytes.length > MAX_SITE_BYTES) { db.exec('ROLLBACK'); return reply(res, 507, { error: 'L’espace cloud du site est plein.' }); }
        db.prepare('INSERT INTO backups(user_id,game_id,version,hash,size,created_at,data) VALUES(?,?,?,?,?,?,?)')
          .run(user.id, game, version, hash, bytes.length, Date.now(), bytes);
        db.prepare('DELETE FROM backups WHERE user_id=? AND game_id=? AND version<=?').run(user.id, game, version - MAX_HISTORY);
        db.exec('COMMIT');
        return reply(res, 201, { hash, version });
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    }
    return reply(res, 405, { error: 'Méthode refusée.' });
  };
  api.session = session;
  api.googleEnabled = () => google.enabled();
  api.registerPortToken = (user, installation, token) => {
    db.prepare('DELETE FROM port_tokens WHERE expires_at<=?').run(Date.now());
    db.prepare('INSERT OR REPLACE INTO port_tokens VALUES(?,?,?,?)').run(sha256(token), user.id, installation, Date.now() + SESSION_MS);
  };
  api.ownsPortToken = (user, installation, token) => !!db.prepare('SELECT 1 FROM port_tokens WHERE token_hash=? AND user_id=? AND installation=? AND expires_at>?')
    .get(sha256(token), user.id, installation, Date.now());
  return api;
}
