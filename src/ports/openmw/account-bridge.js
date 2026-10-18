// Same-origin launcher requests. Native credentials are private and independent of Orthros passwords.
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, createHash } from 'node:crypto';

export const playerScope = (user) => createHash('sha256').update(user.id).digest('hex').slice(0, 24);
export function accountBridge({ accountsDir, accountApi, getManifest }) {
  const pending = new Map(), issued = new WeakSet(), budgets = new Map();
  async function launch(user, man) {
    const config = JSON.parse(fs.readFileSync(path.join(accountsDir, 'openmw.json'), 'utf8'));
    const operator = config.operators?.[man.id];
    // Catalog ids are passed explicitly below; no username-based adoption of legacy accounts.
    if (!operator || typeof config.secret !== 'string' || config.secret.length < 32) throw new Error('bridge unavailable');
    const key = playerScope(user), name = `orthros-${key}@players.invalid`;
    const password = createHmac('sha256', config.secret).update(`${key}:${man.openmw.multiplayer.port}`).digest('base64url');
    const base = `http://127.0.0.1:${man.openmw.multiplayer.port}`;
    async function request(route, body, token, method = 'POST') {
      const r = await fetch(base + route, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
      return { ok: r.ok, status: r.status, data: await r.json() };
    }
    let login = await request('/auth/password', { name, password });
    if (!login.ok && login.status === 401) {
      const owner = await request('/admin/api/login', operator);
      if (!owner.ok || !owner.data.token) throw new Error('operator unavailable');
      try {
        const created = await request('/admin/api/accounts/create', { name, password, role: '' }, owner.data.token);
        if (!created.ok) throw new Error('player creation failed');
      } finally { await request('/admin/api/logout', {}, owner.data.token); }
      login = await request('/auth/password', { name, password });
    }
    if (!login.ok || !login.data.ticket || !login.data.locker) throw new Error('player login failed');
    const token = login.data.locker, profile = await request('/auth/profile', null, token, 'GET');
    if (!profile.ok) throw new Error('profile unavailable');
    let username = profile.data.username;
    if (profile.data.needsProfile) {
      const stem = user.username.replace(/[^a-z0-9]/gi, '').slice(0, 14).padEnd(3, '0');
      let updated = await request('/auth/profile', { username: stem, email: name }, token);
      if (!updated.ok) updated = await request('/auth/profile', { username: stem.slice(0, 12) + key.slice(0, 8), email: name }, token);
      if (!updated.ok) throw new Error('profile creation failed');
      username = (await request('/auth/profile', null, token, 'GET')).data.username;
    }
    accountApi.registerPortToken(user, man.id, token);
    return { ticket: login.data.ticket, account: login.data.account, locker: token, username };
  }
  function reply(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }); res.end(JSON.stringify(data));
  }
  return {
    handle(req, res, url) {
      const m = /^\/api\/openmw\/([^/]+)\/launch$/.exec(url.pathname);
      if (!m) return false;
      const man = getManifest(m[1]);
      if (man?.runtime !== 'openmw' || !man.openmw.multiplayer) { reply(res, 404, { error: 'Version multijoueur introuvable.' }); return true; }
      if (req.method !== 'POST') { reply(res, 405, { error: 'POST requis.' }); return true; }
      let origin; try { origin = new URL(req.headers.origin); } catch { /* refused below */ }
      if (!origin || !['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host) { reply(res, 403, { error: 'Origine refusée.' }); return true; }
      const user = accountApi?.session(req);
      if (!user) { reply(res, 401, { error: 'Crée un compte Orthros ou connecte-toi pour jouer en multijoueur.' }); return true; }
      req.resume();
      const key = `${m[1]}:${user.id}`, now = Date.now(), budget = budgets.get(key);
      if (budget && now < budget.until && budget.count >= 6) { reply(res, 429, { error: 'Trop de lancements. Réessaie dans une minute.' }); return true; }
      budgets.set(key, { until: budget?.until > now ? budget.until : now + 60000, count: budget?.until > now ? budget.count + 1 : 1 });
      if (budgets.size > 10000) for (const [k, b] of budgets) if (b.until < now) budgets.delete(k);
      if (!pending.has(key)) pending.set(key, launch(user, { ...man, id: m[1] }).finally(() => pending.delete(key)));
      pending.get(key).then((result) => {
        // Concurrent requests must not receive the same one-use game ticket.
        if (issued.has(result)) return reply(res, 409, { error: 'Lancement déjà en cours.' });
        issued.add(result);
        reply(res, 200, result);
      }).catch(() => reply(res, 503, { error: 'Connexion au multijoueur indisponible. Réessaie dans un instant.' }));
      return true;
    },
  };
}
