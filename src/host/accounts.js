// Optional accounts and versioned cloud backups for the browser runtime.
// The game never requires a session: this API only handles user-created backups.
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const scrypt = promisify(scryptCallback);
const COOKIE = 'orthros_session';
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
  return `${COOKIE}=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function requestToken(req) {
  const raw = req.headers.cookie?.split(';').map((x) => x.trim()).find((x) => x.startsWith(`${COOKIE}=`));
  const token = raw?.slice(COOKIE.length + 1) ?? '';
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
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
          seen.has(file.path)) return false;
      seen.add(file.path);
    }
    return true;
  } catch { return false; }
}

export function createAccountApi(dir, { publicOrigin = DEFAULT_ORIGIN, allowedGame = () => true } = {}) {
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
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game_id TEXT NOT NULL, version INTEGER NOT NULL, hash TEXT NOT NULL,
      size INTEGER NOT NULL, created_at INTEGER NOT NULL, data BLOB NOT NULL,
      UNIQUE(user_id, game_id, version)
    );
    CREATE INDEX IF NOT EXISTS backups_latest ON backups(user_id, game_id, version DESC);
  `);
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
    const [salt, expected] = stored.split(':');
    const hash = await passwordHash(password, salt);
    return timingSafeEqual(Buffer.from(hash.split(':')[1], 'hex'), Buffer.from(expected, 'hex'));
  }
  async function jsonBody(req) {
    const bytes = await readBody(req, 4096);
    try { return JSON.parse(bytes.toString('utf8')); } catch { return null; }
  }
  function signIn(res, user, secure) {
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)')
      .run(sha256(token), user.id, Date.now() + SESSION_MS);
    reply(res, 200, { user: { username: user.username } }, { 'Set-Cookie': cookie(token, secure) });
  }

  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (req.method !== 'GET' && req.headers.origin &&
        !allowedOrigins.has(req.headers.origin) && !/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(req.headers.origin))
      return reply(res, 403, { error: 'Origine refusée.' });
    if (req.method !== 'GET' && !req.headers.origin) return reply(res, 403, { error: 'Origine requise.' });
    const secure = req.headers.origin?.startsWith('https:') || req.headers['x-forwarded-proto'] === 'https';
    if (p === '/api/account' && req.method === 'GET') {
      const user = session(req);
      return reply(res, 200, { user: user ? { username: user.username } : null });
    }
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
      return reply(res, 200, { ok: true }, { 'Set-Cookie': cookie('', secure, 0) });
    }
    if (p === '/api/account/password' && req.method === 'POST') {
      const user = session(req); if (!user) return reply(res, 401, { error: 'Connexion requise.' });
      if (limited(req, 'password', 5, 15 * 60_000)) return reply(res, 429, { error: 'Trop de tentatives.' });
      const body = await jsonBody(req), oldPassword = body?.oldPassword, newPassword = body?.newPassword;
      if (typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 128) return reply(res, 400, { error: 'Le nouveau mot de passe doit contenir de 10 à 128 caractères.' });
      const record = db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
      if (!record || typeof oldPassword !== 'string' || !await verifyPassword(oldPassword, record.password_hash)) return reply(res, 403, { error: 'Mot de passe actuel incorrect.' });
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(await passwordHash(newPassword), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(user.id, sha256(requestToken(req)));
      return reply(res, 200, { ok: true });
    }
    if (p === '/api/account' && req.method === 'DELETE') {
      const user = session(req); if (!user) return reply(res, 401, { error: 'Connexion requise.' });
      const body = await jsonBody(req);
      const record = db.prepare('SELECT password_hash FROM users WHERE id=?').get(user.id);
      if (!record || typeof body?.password !== 'string' || !await verifyPassword(body.password, record.password_hash))
        return reply(res, 403, { error: 'Mot de passe incorrect.' });
      db.prepare('DELETE FROM users WHERE id=?').run(user.id);
      return reply(res, 200, { ok: true }, { 'Set-Cookie': cookie('', secure, 0) });
    }
    if (!p.startsWith('/api/cloud')) return reply(res, 404, { error: 'Introuvable.' });
    const user = session(req); if (!user) return reply(res, 401, { error: 'Connexion requise.' });
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
        const bytesUsed = db.prepare('SELECT COALESCE(SUM(size),0) total FROM backups WHERE user_id=?').get(user.id).total;
        if (bytesUsed + bytes.length > MAX_USER_BYTES) { db.exec('ROLLBACK'); return reply(res, 413, { error: 'Espace cloud plein (512 Mo). Supprime une ancienne copie en ligne.' }); }
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
}
