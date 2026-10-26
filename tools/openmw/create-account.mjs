// Provision a player on a password-only OpenMW server. Its operator API stays localhost only.
// Usage: node tools/openmw/create-account.mjs <manifest> <username> --password-stdin
//        [--games-dir dir] [--state-dir dir]
// Read the player's password from stdin; never put a credential in argv or a command log.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { loadGameCatalog, DEFAULT_GAMES_DIR } from '../../src/host/game-catalog.js';
import { OPENMW_STATE_DIR } from '../../src/host/openmw.js';

const args = process.argv.slice(2), [id, name] = args, arg = (k) => args.includes(k) ? args[args.indexOf(k) + 1] : null;
if (!name || !args.includes('--password-stdin')) throw new Error('Expected manifest, username and --password-stdin');
const man = loadGameCatalog(path.resolve(arg('--games-dir') ?? DEFAULT_GAMES_DIR)).get(id);
if (man?.runtime !== 'openmw' || !man.openmw.multiplayer) throw new Error('Expected an OpenMW multiplayer version');
const state = path.resolve(arg('--state-dir') ?? path.join(OPENMW_STATE_DIR, id));
if (!fs.existsSync(state)) throw new Error('Start the multiplayer server before creating players');
const password = fs.readFileSync(0, 'utf8').replace(/[\r\n]+$/, '');
if (!password.length || password.length > 1024) throw new Error('Expected a password on stdin (1–1024 characters)');
const file = path.join(state, 'operator.json');
if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ name: 'orthros@localhost.invalid', password: randomBytes(32).toString('base64url') }), { mode: 0o600, flag: 'wx' });
const operator = JSON.parse(fs.readFileSync(file));
const base = `http://127.0.0.1:${man.openmw.multiplayer.port}`;
async function request(route, body, token) {
  const r = await fetch(base + '/admin/api/' + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  return { ok: r.ok, body: await r.json() };
}
const setup = await request('setup/owner', operator);
// A repeated run logs in with the existing, private operator credential.
const login = await request('login', operator);
if (!login.ok || !login.body.token) throw new Error(`Cannot authenticate the local operator: ${login.body.error ?? setup.body.error}`);
try {
  const r = await request('accounts/create', { name, password, role: '' }, login.body.token);
  if (!r.ok) throw new Error(r.body.error ?? 'Player creation failed');
  console.log(`Created OpenMW player ${name}. The account has no administration privileges.`);
} finally { await request('logout', {}, login.body.token); }
