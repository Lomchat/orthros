import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from '../src/host/server.js';
import { suggestUsername } from '../src/host/google-signin.js';

// A fake Google: its sign-in page is never visited — the test reads the state and nonce from the address the server
// sends the window to, and its token endpoint answers with an ID token for whichever player the next code names.
function fakeGoogle() {
  const codes = new Map();
  const jwt = (claims) => ['{"alg":"RS256"}', JSON.stringify(claims), 'sig'].map((s, i) => (i < 2 ? Buffer.from(s).toString('base64url') : s)).join('.');
  const google = {
    clientId: 'client-1.apps.googleusercontent.com', clientSecret: 'secret', auth: 'https://google.test/auth', token: 'https://google.test/token',
    fetch: async (url, init) => {
      const form = new URLSearchParams(init.body.toString());
      const issued = codes.get(form.get('code'));
      if (!issued || form.get('client_secret') !== 'secret' || createHash('sha256').update(form.get('code_verifier')).digest('base64url') !== issued.challenge)
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      codes.delete(form.get('code'));
      return new Response(JSON.stringify({ id_token: jwt({ iss: 'https://accounts.google.com', aud: google.clientId, exp: Date.now() / 1000 + 3600, nonce: issued.nonce, ...issued.claims }) }));
    },
  };
  return { google, issue: (location, claims, nonce) => { const q = new URL(location).searchParams; const code = Math.random().toString(36).slice(2);
    codes.set(code, { challenge: q.get('code_challenge'), nonce: nonce ?? q.get('nonce'), claims }); return { state: q.get('state'), code }; } };
}

test('Google sign-in: a new player chooses a name, comes back signed in, links and unlinks; flows bound to their browser', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-google-'));
  const games = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-google-games-'));
  fs.mkdirSync(path.join(games, 'fixture', 'base'), { recursive: true }); fs.mkdirSync(path.join(games, 'fixture', 'versions', 'v1'), { recursive: true });
  fs.writeFileSync(path.join(games, 'fixture', 'base', 'game.exe'), 'MZ');
  fs.writeFileSync(path.join(games, 'fixture', 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'fixture', name: 'Fixture', defaultVersion: 'g1', versions: [{ id: 'g1', dir: 'v1', version: '1', exe: 'game.exe' }] }));
  const fake = fakeGoogle();
  const server = createServer({ accountsDir: dir, gamesDir: games, accountOrigin: 'http://localhost:8080', accountGoogle: fake.google });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const cookieOf = (res, name) => res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '=') && c.length > name.length + 1);
  const get = (route, cookie) => fetch(base + route, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  const post = (route, body, cookie) => fetch(base + route, { method: 'POST', body: JSON.stringify(body), headers: { Origin: 'http://localhost:8080', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) } });
  const me = async (cookie) => (await (await get('/api/account', cookie)).json()).user;
  /** start → Google → callback: the callback's answer, with the flow's own cookie unless `cookie` says otherwise. */
  const flow = async (claims, { link = null, nonce, binding } = {}) => {
    const start = await get(`/api/account/google/start?lang=fr&popup=1&flow=abcdefgh1${link ? '&link=1' : ''}`, link);
    assert.equal(start.status, 302);
    const location = start.headers.get('location');
    assert.match(location, /^https:\/\/google\.test\/auth\?/);
    assert.equal(new URL(location).searchParams.get('redirect_uri'), 'http://localhost:8080/api/account/google/callback');
    assert.equal(new URL(location).searchParams.get('code_challenge_method'), 'S256');
    assert.match(start.headers.getSetCookie()[0], /SameSite=Lax/);
    const { state, code } = fake.issue(location, claims, nonce);
    return get(`/api/account/google/callback?state=${state}&code=${code}`, binding ?? cookieOf(start, 'orthros_oauth'));
  };
  try {
    assert.equal((await (await get('/api/config')).json()).google, true);
    // (a new player: the name page, then the account)
    const first = await flow({ sub: '111', email: 'ana.lopez@gmail.com', given_name: 'Ana', name: 'Ana López' });
    assert.equal(first.status, 200);
    const page = await first.text();
    assert.match(page, /Bienvenue, Ana/); assert.match(page, /value="ana\.lopez"/); assert.match(page, /ana\.lopez@gmail\.com/);
    const signup = cookieOf(first, 'orthros_google');
    assert.equal((await post('/api/account/google/complete', { mode: 'create', username: 'Bad name!' }, signup)).status, 400);
    const made = await post('/api/account/google/complete', { mode: 'create', username: 'ana_l' }, signup);
    assert.equal(made.status, 200);
    const ana = cookieOf(made, 'orthros_session');
    assert.deepEqual(await me(ana), { username: 'ana_l', google: 'ana.lopez@gmail.com', password: false });
    assert.equal((await post('/api/account/google/complete', { mode: 'create', username: 'ana_2' }, signup)).status, 400, 'a name page serves once');
    assert.equal((await post('/api/account/login', { username: 'ana_l', password: '' })).status, 401, 'no password: no password sign-in');
    // (she comes back: signed in at once, the window tells the page)
    const again = await flow({ sub: '111', email: 'ana.lopez@gmail.com' });
    const html = await again.text();
    assert.match(html, /Connecté en tant que ana_l/); assert.match(html, /"result":"signed-in"/); assert.match(html, /"flow":"abcdefgh1"/);
    assert.equal((await me(cookieOf(again, 'orthros_session'))).username, 'ana_l');
    // (a flow serves once, and only in the browser that started it; Google's checks)
    const start = await get('/api/account/google/start?lang=en');
    const { state, code } = fake.issue(start.headers.get('location'), { sub: '111' });
    assert.equal((await get(`/api/account/google/callback?state=${state}&code=${code}`, 'orthros_oauth=' + 'a'.repeat(64))).status, 400);
    assert.equal((await get(`/api/account/google/callback?state=${state}&code=${code}`, cookieOf(start, 'orthros_oauth'))).status, 400, 'used up');
    assert.equal((await flow({ sub: '111' }, { nonce: 'other' })).status, 502);
    const denied = await get('/api/account/google/start?lang=en'); const s2 = new URL(denied.headers.get('location')).searchParams.get('state');
    assert.match(await (await get(`/api/account/google/callback?state=${s2}&error=access_denied`, cookieOf(denied, 'orthros_oauth'))).text(), /Google sign-in cancelled/);
    // (a password account links Google; the same Google account cannot go to a second one)
    const bob = cookieOf(await post('/api/account/register', { username: 'bob', password: 'long secret password' }), 'orthros_session');
    assert.match(await (await flow({ sub: '222', email: 'bob@example.com' }, { link: bob })).text(), /"result":"linked"/);
    assert.equal((await me(bob)).google, 'bob@example.com');
    assert.match(await (await flow({ sub: '111' }, { link: bob })).text(), /"result":"taken"/);
    assert.equal((await get('/api/account/google/start?link=1')).status, 401, 'linking needs a signed-in account');
    // (a new Google account, an existing Orthros one: its password links them)
    const carol = cookieOf(await post('/api/account/register', { username: 'carol', password: 'carol long password' }), 'orthros_session');
    const third = cookieOf(await flow({ sub: '333', email: 'c@example.com' }), 'orthros_google');
    assert.equal((await post('/api/account/google/complete', { mode: 'existing', username: 'carol', password: 'wrong password!' }, third)).status, 401);
    assert.equal((await post('/api/account/google/complete', { mode: 'existing', username: 'bob', password: 'long secret password' }, third)).status, 409, 'bob has his Google already');
    const linked = await post('/api/account/google/complete', { mode: 'existing', username: 'carol', password: 'carol long password' }, third);
    assert.equal(linked.status, 200); assert.equal((await me(carol)).google, 'c@example.com');
    // (no password: unlinking refused until one is set; then a password sign-in works)
    assert.equal((await post('/api/account/google/unlink', {}, ana)).status, 409);
    assert.equal((await post('/api/account/password', { newPassword: 'ana new password' }, ana)).status, 200);
    assert.equal((await post('/api/account/google/unlink', {}, ana)).status, 200);
    assert.deepEqual(await me(ana), { username: 'ana_l', google: null, password: true });
    assert.equal((await post('/api/account/login', { username: 'ana_l', password: 'ana new password' })).status, 200);
    // (an account made with Google is deleted with its name typed again)
    const dan = cookieOf(await post('/api/account/google/complete', { mode: 'create', username: 'dan' }, cookieOf(await flow({ sub: '444' }), 'orthros_google')), 'orthros_session');
    const del = (body) => fetch(base + '/api/account', { method: 'DELETE', body: JSON.stringify(body), headers: { Origin: 'http://localhost:8080', 'Content-Type': 'application/json', Cookie: dan } });
    assert.equal((await del({ username: 'nope' })).status, 403);
    assert.equal((await del({ username: 'dan' })).status, 200);
    assert.equal(await me(dan), null);
  } finally {
    server.close(); await once(server, 'close');
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(games, { recursive: true, force: true });
  }
});

test('a new player\'s offered name: from the Google address or name, free on the server', () => {
  const none = () => false;
  assert.equal(suggestUsername({ given_name: 'Clément', email: 'x@y.z' }, none), 'clement');
  assert.equal(suggestUsername({ given_name: 'Al', email: 'al.dupont+jeux@gmail.com' }, none), 'al.dupont');
  assert.equal(suggestUsername({}, none), 'joueur');
  const taken = new Set(['clement']);
  assert.match(suggestUsername({ given_name: 'Clément' }, (n) => taken.has(n)), /^clement\d{2,4}$/);
});
