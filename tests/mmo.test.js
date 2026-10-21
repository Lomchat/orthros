// Shared worlds ("MMO", src/host/mmo.js, protocol src/host/mmo-proto.js): the manifest's `mmo` entry, the status route,
// refusals, the lobby (characters), joining, the relay and its ownership rules, departures, records and locks, chat,
// world changes by admins, the world clock frozen while nobody is there, persistence across a restart, and the limits.
// Players are real Orthros accounts of a server with accounts; their WebSockets are Node's own (Cookie and Origin set).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { createServer } from '../src/host/server.js';
import { loadGameCatalog } from '../src/host/game-catalog.js';
import { mmoProblem, mmoSettings } from '../src/host/mmo.js';
import { MMO_C as C, MMO_S as S, MMO_REFUSED as R, MMO_RESULT as CR, MMO_DENIED as D, MMO_NOBODY as NOBODY, mmoClientRecord, mmoServerRecords, mmoPlayerId } from '../src/host/mmo-proto.js';

const SCRATCH = path.join(os.tmpdir(), 'orthros-scratch', 'mmo-test');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A games folder: one game, a version with a shared world (`mmo`) and one without; no engine needed. */
function fixture(t, mmo = { maxCharacters: 2, maxPlayers: 3 }) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const root = fs.mkdtempSync(path.join(SCRATCH, 'run-')), closers = [];
  // (the servers closed first — closing saves the worlds — then the folder removed)
  t.after(async () => {
    for (const close of closers) await close();
    fs.rmSync(root, { recursive: true, force: true });
    try { fs.rmdirSync(SCRATCH); } catch { /* another run's still there */ }
  });
  const games = path.join(root, 'games'), game = path.join(games, 'city');
  for (const d of ['base', 'versions/online', 'versions/solo']) fs.mkdirSync(path.join(game, d), { recursive: true });
  fs.writeFileSync(path.join(game, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'city', name: 'City', defaultVersion: 'city-online', defaults: { runtime: 're3' },
    versions: [{ id: 'city-online', dir: 'online', version: '1', re3: { engine: 'eng-1' }, mmo }, { id: 'city-solo', dir: 'solo', version: '1', re3: { engine: 'eng-1' } }] }));
  fs.mkdirSync(path.join(root, 'engines'));
  return { root, games, game, engines: path.join(root, 'engines'), accounts: path.join(root, 'accounts'), mmoDir: path.join(root, 'accounts', 'mmo'), closers };
}
/** The server's clock: still unless the test moves it (rates, the world's minutes and silences exactly as the test says). */
const clock = () => { let t = Date.now(); const now = () => t; now.skip = (ms) => { t += ms; }; return now; };

async function serve(t, f, opts = {}) {
  const now = opts.mmoNow ?? clock();
  const server = createServer({ gamesDir: f.games, enginesDir: f.engines, accountsDir: f.accounts, lanLog: () => {}, mmoLog: () => {}, mmoNow: now, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  let closing = null;
  const close = () => (closing ??= new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  f.closers.push(close);
  const base = `http://127.0.0.1:${server.address().port}`;
  let ip = 0;
  /** A new account (its own forwarded address: registrations are limited per address), its session cookie. */
  const account = async (username) => {
    ip++;
    const r = await fetch(base + '/api/account/register', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-Forwarded-For': `10.77.${ip >> 8}.${ip & 255}` }, body: JSON.stringify({ username, password: 'orthros-test-password' }) });
    assert.equal(r.status, 200, `register ${username}`);
    return r.headers.get('set-cookie').split(';')[0];
  };
  return { server, base, now, close, account };
}

/** Record bodies, little-endian. */
const w = () => {
  const parts = [], o = {
    u8: (v) => { parts.push(Buffer.from([v & 255])); return o; },
    u16: (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); parts.push(b); return o; },
    u32: (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); parts.push(b); return o; },
    i32: (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); parts.push(b); return o; },
    f32: (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); parts.push(b); return o; },
    f64: (v) => { const b = Buffer.alloc(8); b.writeDoubleLE(v); parts.push(b); return o; },
    str8: (s) => { const b = Buffer.from(s, 'latin1'); parts.push(Buffer.from([b.length]), b); return o; },
    bytes: (b) => { parts.push(Buffer.from(b)); return o; },
    done: () => Buffer.concat(parts),
  };
  return o;
};
const rd = (b) => {
  let o = 0;
  const take = (n) => { assert.ok(o + n <= b.length, 'record too short'); const v = b.subarray(o, o + n); o += n; return v; };
  const r = { take, u8: () => take(1)[0], u16: () => take(2).readUInt16LE(0), u32: () => take(4).readUInt32LE(0), i32: () => take(4).readInt32LE(0),
    f32: () => take(4).readFloatLE(0), f64: () => take(8).readDoubleLE(0), str8: () => take(r.u8()).toString('latin1'), left: () => b.length - o };
  return r;
};
const lobbyOf = (body) => {
  const r = rd(body), out = { admin: r.u8(), maxCharacters: r.u8(), username: r.str8(), characters: [] };
  for (let n = r.u8(); n > 0; n--) out.characters.push({ id: r.u32(), name: r.str8(), skin: r.str8(), money: r.i32(), online: r.u8() });
  return out;
};
const infoOf = (r) => ({ slot: r.u8(), rank: r.u32(), admin: r.u8(), away: r.u8(), name: r.str8(), skin: r.str8() });
const worldOf = (r) => {
  const out = { baseMs: r.f64(), baseMinutes: r.f64(), msPerMinute: r.f32(), vars: {} };
  for (let n = r.u8(); n > 0; n--) { const id = r.u8(); out.vars[id] = r.i32(); }
  return out;
};
const welcomeOf = (body) => {
  const r = rd(body), out = { slot: r.u8(), tag: r.u16(), serverMs: r.f64(), admin: r.u8(), charId: r.u32(), name: r.str8(), skin: r.str8() };
  out.state = Buffer.from(r.take(r.u16())); out.world = worldOf(r); out.players = [];
  for (let n = r.u8(); n > 0; n--) out.players.push(infoOf(r));
  assert.equal(r.left(), 0);
  return out;
};
const resultOf = (body) => ({ op: body[0], status: body[1], id: body.readUInt32LE(2) });
const ownerOf = (body) => ({ netid: body.readUInt32LE(0), owner: body[4], previous: body[5] });
const recordOf = (body) => { const r = rd(body); return { key: r.u16(), holder: r.u8(), data: Buffer.from(r.take(r.u16())) }; };
const chatOf = (body) => { const r = rd(body); return { kind: r.u8(), name: r.str8(), text: r.str8() }; };
const pstate = (x, y, z) => w().f32(x).f32(y).f32(z).bytes([1, 2, 3]).done();
const estate = (netid, flags, x, y, z) => w().u32(netid).u8(2).u8(flags).f32(x).f32(y).f32(z).bytes([7, 7]).done();

/** A WebSocket of the shared world: its server records kept in order of arrival, taken by type. */
class Peer {
  constructor(ws) {
    this.ws = ws; this.inbox = []; this.messages = []; this.closed = false; this.wake = null;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (e) => {
      const recs = mmoServerRecords(new Uint8Array(e.data)).map((r) => ({ type: r.type, from: r.from, body: Buffer.from(r.body) }));
      this.messages.push(recs.map((r) => r.type));
      this.inbox.push(...recs); this.wake?.();
    });
    this.done = new Promise((resolve) => ws.addEventListener('close', () => { this.closed = true; this.wake?.(); resolve(); }));
  }
  static open(ctx, cookie, version = 'city-online', origin = ctx.base) {
    const ws = new WebSocket(`${ctx.base.replace('http', 'ws')}/api/mmo/${version}/ws`, { headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: origin } });
    const p = new Peer(ws);
    return new Promise((resolve, reject) => { ws.addEventListener('open', () => resolve(p)); ws.addEventListener('error', () => reject(new Error('websocket error'))); });
  }
  /** Records sent in one message: [type, body]... */
  send(...records) { this.ws.send(Buffer.concat(records.map(([type, body]) => mmoClientRecord(type, body ?? Buffer.alloc(0))))); }
  async next(type, ms = 3000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = this.inbox.findIndex((r) => r.type === type);
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      const left = deadline - Date.now();
      if (this.closed || left <= 0) throw new Error(`no record 0x${type.toString(16)} (${this.closed ? 'closed' : 'timeout'}; inbox: ${this.inbox.map((r) => r.type.toString(16))})`);
      await new Promise((r) => { const tm = setTimeout(r, left); this.wake = () => { clearTimeout(tm); r(); }; });
      this.wake = null;
    }
  }
  /** None of `type` within `ms` (default: every record type). */
  async quiet(type = null, ms = 150) {
    await sleep(ms);
    const got = this.inbox.filter((r) => type === null || r.type === type);
    assert.equal(got.length, 0, `unexpected records: ${got.map((r) => r.type.toString(16))}`);
  }
  clear() { this.inbox = []; this.messages = []; }
  close() { this.ws.close(); return this.done; }
}

async function hello(p) { p.send([C.HELLO, w().u16(1).u8(0).done()]); return lobbyOf((await p.next(S.LOBBY)).body); }
/** A lobby request answered by CHAR_RESULT then LOBBY (the clock moved on a little: lobby requests are limited to 5/s). */
async function lobbyRequest(ctx, p, type, body) {
  ctx.now.skip(250);
  p.send([type, body]);
  const result = resultOf((await p.next(S.CHAR_RESULT)).body);
  return { ...result, lobby: lobbyOf((await p.next(S.LOBBY)).body) };
}
const create = (ctx, p, name, skin = 'player') => lobbyRequest(ctx, p, C.CHAR_CREATE, w().str8(name).str8(skin).done());
async function join(ctx, p, id) { ctx.now.skip(250); p.send([C.JOIN, w().u32(id).done()]); return welcomeOf((await p.next(S.WELCOME)).body); }
/** A signed-in player in the world: its socket, its WELCOME. */
async function player(ctx, cookie, name, skin = 'player') {
  const p = await Peer.open(ctx, cookie);
  const lobby = await hello(p);
  const known = lobby.characters.find((c) => c.name === name);
  const id = known ? known.id : (await create(ctx, p, name, skin)).id;
  const welcome = await join(ctx, p, id);
  return { p, welcome, id };
}
/** An upgrade request answered by HTTP (a refused handshake): its status. */
function rawUpgrade(base, route, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(base + route, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64'), ...headers } });
    req.on('error', reject);
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('upgrade', (_res, socket) => { socket.destroy(); resolve(101); });
  });
}

test('a version\'s `mmo` entry: checked by the catalog (any runtime) and the schema alike, its defaults', (t) => {
  for (const ok of [undefined, {}, { maxCharacters: 1 }, { maxCharacters: 16, maxPlayers: 2 }, { maxPlayers: 32 }, { records: [[256, 267]] }, { records: [[0, 0], [5, 65535]] }])
    assert.equal(mmoProblem(ok), null, JSON.stringify(ok));
  for (const bad of [null, [], 'yes', true, { maxCharacters: 0 }, { maxCharacters: 17 }, { maxCharacters: 2.5 }, { maxCharacters: '8' }, { maxPlayers: 1 }, { maxPlayers: 33 }, { maxPlayers: 16, world: 'x' },
    { records: [] }, { records: [[2, 1]] }, { records: [[0, 65536]] }, { records: [[1]] }, { records: [256, 267] }, { records: [[1.5, 2]] }, { records: Array(65).fill([0, 1]) }])
    assert.match(mmoProblem(bad), /^mmo :/, JSON.stringify(bad));
  assert.deepEqual(mmoSettings({}), { maxCharacters: 8, maxPlayers: 16 });
  assert.deepEqual(mmoSettings({ maxPlayers: 4 }), { maxCharacters: 8, maxPlayers: 4 });
  assert.deepEqual(mmoSettings({ records: [[256, 267]] }), { maxCharacters: 8, maxPlayers: 16, records: [[256, 267]] });
  const f = fixture(t);
  const catalog = loadGameCatalog(f.games, null, { enginesDir: f.engines });
  assert.deepEqual(catalog.get('city-online').mmo, { maxCharacters: 2, maxPlayers: 3 });
  assert.equal(catalog.get('city-solo').mmo, undefined);
  const edit = (fn) => { const file = path.join(f.game, 'manifest.json'), spec = JSON.parse(fs.readFileSync(file, 'utf8')); fn(spec); fs.writeFileSync(file, JSON.stringify(spec)); };
  edit((spec) => { spec.versions[0].mmo = { maxPlayers: 64 }; });
  assert.throws(() => loadGameCatalog(f.games, null, { enginesDir: f.engines }), /city-online: mmo :/);
  // (in defaults too, and on a Windows game: nothing ties a shared world to a runtime)
  edit((spec) => { delete spec.versions[0].mmo; spec.defaults.mmo = { maxPlayers: 4 }; });
  assert.equal(loadGameCatalog(f.games, null, { enginesDir: f.engines }).get('city-solo').mmo.maxPlayers, 4);
  fs.writeFileSync(path.join(f.game, 'base', 'game.exe'), 'MZ');
  edit((spec) => { delete spec.defaults.mmo; spec.versions[0] = { id: 'city-online', dir: 'online', version: '1', runtime: 'win32', exe: 'game.exe', mmo: { maxCharacters: 3 } }; });
  assert.equal(loadGameCatalog(f.games, null, { enginesDir: f.engines }).get('city-online').mmo.maxCharacters, 3);
  // (the schema says the same)
  const schema = JSON.parse(fs.readFileSync(new URL('../docs/game-manifest.schema.json', import.meta.url), 'utf8')).properties.versions.items.properties.mmo;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties).sort(), ['maxCharacters', 'maxPlayers', 'records']);
  assert.deepEqual([schema.properties.records.minItems, schema.properties.records.maxItems, schema.properties.records.items.items.minimum, schema.properties.records.items.items.maximum], [1, 64, 0, 65535]);
  for (const [key, [lo, hi, def]] of Object.entries({ maxCharacters: [1, 16, 8], maxPlayers: [2, 32, 16] })) {
    const s = schema.properties[key];
    assert.deepEqual([s.type, s.minimum, s.maximum, s.default], ['integer', lo, hi, def]);
    assert.equal(mmoProblem({ [key]: lo - 1 }) === null, false); assert.equal(mmoProblem({ [key]: lo }), null);
    assert.equal(mmoProblem({ [key]: hi }), null); assert.equal(mmoProblem({ [key]: hi + 1 }) === null, false);
  }
});

test('the status route, the home\'s flags and the socket\'s refusals: other sites, nobody signed in, no shared world, another protocol', async (t) => {
  const f = fixture(t), ctx = await serve(t, f);
  const status = async (id, cookie) => { const r = await fetch(`${ctx.base}/api/mmo/${id}`, { headers: cookie ? { Cookie: cookie } : {} }); return [r.status, r.headers.get('cache-control'), await r.json()]; };
  assert.deepEqual(await status('city-online'), [200, 'no-store', { enabled: true, signedIn: false, admin: false, players: 0, maxPlayers: 3 }]);
  assert.deepEqual((await status('city-solo'))[2], { enabled: false, signedIn: false, admin: false, players: 0, maxPlayers: 0 });
  assert.equal((await status('nothing-here'))[0], 404);
  const manifests = await (await fetch(ctx.base + '/api/manifests')).json();
  assert.deepEqual(['city-online', 'city-solo'].map((id) => manifests.find((m) => m.name === id).mmo), [true, false]);
  assert.equal((await (await fetch(ctx.base + '/api/config')).json()).mmo, true);
  assert.deepEqual((await (await fetch(ctx.base + '/api/manifest/city-online')).json()).mmo, { maxCharacters: 2, maxPlayers: 3 }, 'the page reads the version\'s settings');
  const cookie = await ctx.account('alice');
  assert.deepEqual((await status('city-online', cookie))[2], { enabled: true, signedIn: true, admin: false, players: 0, maxPlayers: 3 });
  // (another site's page — or none — gets no socket: a plain 403)
  assert.equal(await rawUpgrade(ctx.base, '/api/mmo/city-online/ws', { Cookie: cookie, Origin: 'http://elsewhere.example' }), 403);
  assert.equal(await rawUpgrade(ctx.base, '/api/mmo/city-online/ws', { Cookie: cookie }), 403);
  assert.equal(await rawUpgrade(ctx.base, '/api/mmo/city-online/ws', { Cookie: cookie, Origin: ctx.base }), 101);
  // (refusals the page can read: REFUSED, then the socket closed)
  const refused = async (cookie2, version, records = []) => {
    const p = await Peer.open(ctx, cookie2, version);
    if (records.length) p.send(...records);
    const r = await p.next(S.REFUSED); await p.done;
    return [r.body[0], rd(r.body.subarray(1)).str8()];
  };
  assert.deepEqual(await refused(null, 'city-online'), [R.SIGN_IN, 'sign-in needed']);
  assert.equal((await refused(cookie, 'city-solo'))[0], R.NO_WORLD);
  assert.equal((await refused(cookie, 'nothing-here'))[0], R.NO_WORLD);
  assert.equal((await refused(cookie, 'city-online', [[C.HELLO, w().u16(2).u8(0).done()]]))[0], R.PROTOCOL);
  // (a record too short for its type: DENIED, the connection kept)
  const p = await Peer.open(ctx, cookie);
  p.send([C.HELLO, w().u16(1).u8(1).done()], [C.PING, w().u8(1).done()], [C.PING, w().f64(3).done()]);
  await p.next(S.LOBBY);
  assert.deepEqual([...(await p.next(S.DENIED)).body], [C.PING, D.INVALID]);
  await p.next(S.PONG);
  assert.equal(p.closed, false);
});

test('a server without accounts has no shared world', async (t) => {
  const f = fixture(t), ctx = await serve(t, f, { accountsDir: undefined });
  assert.equal((await (await fetch(ctx.base + '/api/config')).json()).mmo, false);
  assert.equal((await (await fetch(ctx.base + '/api/mmo/city-online')).json()).enabled, false);
  const p = await Peer.open(ctx, null);
  assert.equal((await p.next(S.REFUSED)).body[0], R.NO_WORLD);
  await p.done;
});

test('the lobby: characters per account, their names\' rules, unique names, the account\'s maximum, skins, deletion', async (t) => {
  const f = fixture(t), ctx = await serve(t, f);
  const a = await Peer.open(ctx, await ctx.account('alice')), b = await Peer.open(ctx, await ctx.account('bob'));
  assert.deepEqual(await hello(a), { admin: 0, maxCharacters: 2, username: 'alice', characters: [] });
  await hello(b);
  for (const name of ['a', ' ab', 'ab!', '-ab', 'x'.repeat(17), 'caf\xe9', 'a\tb', '', 'Tommy ', 'Tommy.', 'Tom  my', 'Tom._my', 'ab-'])
    assert.equal((await create(ctx, a, name)).status, CR.INVALID_NAME, JSON.stringify(name));
  for (const skin of ['', 'bad skin', 'x'.repeat(21), 'a-b']) assert.equal((await create(ctx, a, 'Tommy', skin)).status, CR.INVALID_SKIN, skin);
  const tommy = await create(ctx, a, 'Tommy', 'player');
  assert.deepEqual([tommy.op, tommy.status], [2, CR.OK]); assert.ok(tommy.id > 0);
  assert.deepEqual(tommy.lobby.characters, [{ id: tommy.id, name: 'Tommy', skin: 'player', money: 0, online: 0 }]);
  assert.equal((await create(ctx, b, 'TOMMY')).status, CR.NAME_TAKEN, 'names are unique whatever their case');
  for (const same of ['Tom my', 'tom_my', 'T.o.m.m.y', 'to-mmy']) assert.equal((await create(ctx, b, same)).status, CR.NAME_TAKEN, `${same}: whatever its separators`);
  const lance = await create(ctx, a, 'Lance V', 'hmyst');
  assert.equal(lance.status, CR.OK); assert.equal(lance.lobby.characters.length, 2);
  assert.equal((await create(ctx, a, 'Third')).status, CR.TOO_MANY);
  // (skins: the account's own characters only)
  const skin = await lobbyRequest(ctx, a, C.CHAR_SKIN, w().u32(tommy.id).str8('ply_7').done());
  assert.deepEqual([skin.op, skin.status, skin.id], [3, CR.OK, tommy.id]);
  assert.equal(skin.lobby.characters.find((c) => c.id === tommy.id).skin, 'ply_7');
  assert.equal((await lobbyRequest(ctx, a, C.CHAR_SKIN, w().u32(tommy.id).str8('no way').done())).status, CR.INVALID_SKIN);
  assert.equal((await lobbyRequest(ctx, b, C.CHAR_SKIN, w().u32(tommy.id).str8('player').done())).status, CR.NOT_FOUND);
  assert.equal((await lobbyRequest(ctx, b, C.CHAR_DELETE, w().u32(lance.id).done())).status, CR.NOT_FOUND);
  const gone = await lobbyRequest(ctx, a, C.CHAR_DELETE, w().u32(lance.id).done());
  assert.deepEqual([gone.op, gone.status], [4, CR.OK]); assert.deepEqual(gone.lobby.characters.map((c) => c.name), ['Tommy']);
  assert.equal((await create(ctx, b, 'lance.v')).status, CR.OK, 'a deleted character\'s name is free again');
  // (a character in the world is not deleted)
  await join(ctx, a, tommy.id);
  assert.equal((await lobbyRequest(ctx, a, C.CHAR_DELETE, w().u32(tommy.id).done())).status, CR.ERROR);
  // (lobby requests before HELLO: denied)
  const c = await Peer.open(ctx, await ctx.account('carol'));
  c.send([C.CHAR_CREATE, w().str8('Early').str8('player').done()]);
  assert.deepEqual([...(await c.next(S.DENIED)).body], [C.CHAR_CREATE, D.INVALID]);
});

test('joining: WELCOME with the world and its players, the others told; full worlds, others\' characters, leaving, joining elsewhere', async (t) => {
  const f = fixture(t), ctx = await serve(t, f);
  const alice = await ctx.account('alice'), bob = await ctx.account('bob'), carol = await ctx.account('carol');
  const before = ctx.now();
  const a = await player(ctx, alice, 'Tommy');
  assert.deepEqual([a.welcome.slot, a.welcome.admin, a.welcome.charId, a.welcome.name, a.welcome.skin, a.welcome.state.length], [0, 0, a.id, 'Tommy', 'player', 0]);
  assert.ok(a.welcome.tag >= 1 && a.welcome.tag <= 0xffe);
  assert.ok(a.welcome.serverMs >= before && a.welcome.serverMs <= ctx.now());
  assert.deepEqual([a.welcome.world.baseMinutes, a.welcome.world.msPerMinute, a.welcome.world.vars], [720, 1000, {}], 'a new world: 12:00 of day 0, a game minute a second');
  assert.deepEqual(a.welcome.players, [{ slot: 0, rank: 1, admin: 0, away: 0, name: 'Tommy', skin: 'player' }], 'the players: itself included (its rank)');
  const b = await player(ctx, bob, 'Lance');
  assert.equal(b.welcome.slot, 1); assert.notEqual(b.welcome.tag, a.welcome.tag);
  assert.deepEqual(b.welcome.players.map((p) => [p.slot, p.rank, p.name]), [[0, 1, 'Tommy'], [1, 2, 'Lance']]);
  const joined = await a.p.next(S.PLAYER_JOIN);
  assert.equal(joined.from, NOBODY); assert.deepEqual(infoOf(rd(joined.body)), { slot: 1, rank: 2, admin: 0, away: 0, name: 'Lance', skin: 'player' });
  assert.equal((await fetch(`${ctx.base}/api/mmo/city-online`)).status, 200);
  assert.equal((await (await fetch(`${ctx.base}/api/mmo/city-online`)).json()).players, 2);
  // (the lobby says which characters are in the world)
  const second = await create(ctx, b.p, 'Rosie');
  assert.deepEqual(second.lobby.characters.map((c) => [c.name, c.online]), [['Lance', 1], ['Rosie', 0]]);
  // (someone else's character: not found)
  ctx.now.skip(250); b.p.send([C.JOIN, w().u32(a.id).done()]);
  assert.deepEqual(resultOf((await b.p.next(S.CHAR_RESULT)).body), { op: 5, status: CR.NOT_FOUND, id: a.id });
  assert.equal(b.p.closed, false);
  // (full: 3 players at most here)
  const c = await player(ctx, carol, 'Mercedes');
  assert.equal(c.welcome.slot, 2);
  const b2 = await Peer.open(ctx, bob); await hello(b2);
  ctx.now.skip(250); b2.send([C.JOIN, w().u32(second.id).done()]);
  assert.deepEqual(resultOf((await b2.next(S.CHAR_RESULT)).body), { op: 5, status: CR.WORLD_FULL, id: second.id });
  // (leaving: LEFT, then the lobby; the others told)
  a.p.clear();
  ctx.now.skip(250); c.p.send([C.LEAVE]);
  await c.p.next(S.LEFT);
  assert.equal(lobbyOf((await c.p.next(S.LOBBY)).body).characters[0].online, 0);
  assert.deepEqual([...(await a.p.next(S.PLAYER_LEAVE)).body], [2]);
  // (the same character joined from another connection: the older one refused (5), the newer in the world)
  const a2 = await Peer.open(ctx, alice); await hello(a2);
  b.p.clear();
  const again = await join(ctx, a2, a.id);
  assert.equal((await a.p.next(S.REFUSED)).body[0], R.ELSEWHERE); await a.p.done;
  assert.deepEqual([...(await b.p.next(S.PLAYER_LEAVE)).body], [0]);
  assert.equal(infoOf(rd((await b.p.next(S.PLAYER_JOIN)).body)).name, 'Tommy');
  assert.equal(again.slot, 0); assert.ok(again.players.find((p) => p.name === 'Tommy').rank > 2, 'a new rank: the junior now');
});

test('the relay: the sender\'s slot stamped, realtime records to the others, one message per turn; entity states from their owner only; TARGETED to the target\'s owner', async (t) => {
  const f = fixture(t), ctx = await serve(t, f);
  const a = await player(ctx, await ctx.account('alice'), 'Tommy'), b = await player(ctx, await ctx.account('bob'), 'Lance');
  const c = await player(ctx, await ctx.account('carol'), 'Mercedes');
  await a.p.next(S.PLAYER_JOIN); await a.p.next(S.PLAYER_JOIN); await b.p.next(S.PLAYER_JOIN);
  for (const p of [a, b, c]) p.p.clear();
  const sa = a.welcome.slot, sb = b.welcome.slot, sc = c.welcome.slot;
  const entity = ((a.welcome.tag << 20) | 1) >>> 0;
  a.p.send([C.PLAYER_STATE, pstate(1, 2, 3)], [C.EVENT, w().u8(0x21).bytes([5, 6]).done()], [C.ENTITY_STATE, estate(entity, 0, 10, 0, 0)]);
  for (const p of [b.p, c.p]) {
    const st = await p.next(C.PLAYER_STATE);
    assert.equal(st.from, sa); assert.deepEqual(st.body, pstate(1, 2, 3));
    assert.deepEqual((await p.next(C.EVENT)).body, w().u8(0x21).bytes([5, 6]).done());
    assert.deepEqual((await p.next(C.ENTITY_STATE)).body, estate(entity, 0, 10, 0, 0));
    assert.deepEqual(p.messages[0], [C.PLAYER_STATE, C.EVENT, C.ENTITY_STATE], 'one message for the turn\'s records');
  }
  await a.p.quiet(null, 100);
  // (another's entity: dropped — states, removals)
  b.p.send([C.ENTITY_STATE, estate(entity, 0, 0, 0, 0)], [C.ENTITY_GONE, w().u32(entity).u8(1).done()]);
  await a.p.quiet(null); await c.p.quiet(null, 0);
  // (TARGETED: to the owner of the target only — an entity's, a player's own id)
  b.p.send([C.TARGETED, w().u32(entity).u8(0x20).bytes([9]).done()], [C.TARGETED, w().u32(mmoPlayerId(sc)).u8(0x21).done()], [C.TARGETED, w().u32(0x00500001).u8(0x22).done()]);
  const hit = await a.p.next(C.TARGETED);
  assert.equal(hit.from, sb); assert.deepEqual(hit.body, w().u32(entity).u8(0x20).bytes([9]).done());
  assert.equal((await c.p.next(C.TARGETED)).body[4], 0x21);
  await a.p.quiet(C.TARGETED); await c.p.quiet(C.TARGETED, 0); await b.p.quiet(C.TARGETED, 0);
  // (its owner's ENTITY_GONE: relayed)
  a.p.send([C.ENTITY_GONE, w().u32(entity).u8(3).done()]);
  assert.equal((await b.p.next(C.ENTITY_GONE)).from, sa);
  // (malformed realtime records: DENIED, at most once a second)
  a.p.send([C.PLAYER_STATE, Buffer.alloc(4)], [C.PLAYER_STATE, Buffer.alloc(300)]);
  assert.deepEqual([...(await a.p.next(S.DENIED)).body], [C.PLAYER_STATE, D.INVALID]);
  await a.p.quiet(S.DENIED); await b.p.quiet(C.PLAYER_STATE, 0);
  // (unknown types: ignored, the connection kept)
  a.p.send([0x5f, Buffer.from([1, 2, 3])], [C.PING, w().f64(42.5).done()]);
  const pong = rd((await a.p.next(S.PONG)).body);
  assert.equal(pong.f64(), 42.5); assert.ok(Math.abs(pong.f64() - ctx.now()) < 1000);
});

test('ownership: claims, gifts, an entity driven by its present owner kept, unchanged answers to the asker only; replayed to a newcomer', async (t) => {
  const f = fixture(t), ctx = await serve(t, f);
  const a = await player(ctx, await ctx.account('alice'), 'Tommy'), b = await player(ctx, await ctx.account('bob'), 'Lance');
  const sa = a.welcome.slot, sb = b.welcome.slot, e = ((a.welcome.tag << 20) | 7) >>> 0, e2 = ((a.welcome.tag << 20) | 8) >>> 0;
  a.p.send([C.ENTITY_STATE, estate(e, 0, 5, 5, 5)], [C.ENTITY_STATE, estate(e2, 1, 5, 5, 5)]);
  await b.p.next(C.ENTITY_STATE); await b.p.next(C.ENTITY_STATE); a.p.clear(); b.p.clear();
  // (a claim: the claimer's, everyone told)
  b.p.send([C.OWN, w().u32(e).u8(1).u8(NOBODY).done()]);
  for (const p of [a.p, b.p]) { const o = await p.next(S.OWNER); assert.deepEqual(ownerOf(o.body), { netid: e, owner: sb, previous: sa }); assert.equal(o.from, sb); }
  a.p.send([C.ENTITY_STATE, estate(e, 0, 5, 5, 5)]);
  await b.p.quiet(C.ENTITY_STATE);
  b.p.send([C.ENTITY_STATE, estate(e, 0, 6, 6, 6)]);
  assert.equal((await a.p.next(C.ENTITY_STATE)).from, sb);
  // (a gift: from its owner only, to a player there)
  a.p.send([C.OWN, w().u32(e).u8(2).u8(sa).done()]);
  assert.deepEqual(ownerOf((await a.p.next(S.OWNER)).body), { netid: e, owner: sb, previous: sb }, 'not its owner: unchanged');
  await b.p.quiet(S.OWNER);
  b.p.send([C.OWN, w().u32(e).u8(2).u8(9).done()]);
  assert.deepEqual(ownerOf((await b.p.next(S.OWNER)).body), { netid: e, owner: sb, previous: sb }, 'nobody in that slot: unchanged');
  b.p.send([C.OWN, w().u32(e).u8(2).u8(sa).done()]);
  for (const p of [a.p, b.p]) assert.deepEqual(ownerOf((await p.next(S.OWNER)).body), { netid: e, owner: sa, previous: sb });
  // (driven by its owner's player — flag bit 0 — while that player is there and not away: kept)
  b.p.send([C.OWN, w().u32(e2).u8(1).u8(NOBODY).done()]);
  assert.deepEqual(ownerOf((await b.p.next(S.OWNER)).body), { netid: e2, owner: sa, previous: sa });
  await a.p.quiet(S.OWNER);
  // (a player's id is never claimed)
  b.p.send([C.OWN, w().u32(mmoPlayerId(sa)).u8(1).u8(NOBODY).done()]);
  assert.deepEqual(ownerOf((await b.p.next(S.OWNER)).body), { netid: mmoPlayerId(sa), owner: sa, previous: sa });
  // (an entity given away is kept by its new owner: a newcomer is told after WELCOME)
  b.p.send([C.ENTITY_STATE, estate(((b.welcome.tag << 20) | 1) >>> 0, 0, 0, 0, 0)]);
  await a.p.next(C.ENTITY_STATE);
  a.p.send([C.OWN, w().u32(((b.welcome.tag << 20) | 1) >>> 0).u8(1).u8(NOBODY).done()]);
  await b.p.next(S.OWNER);
  const c = await player(ctx, await ctx.account('carol'), 'Mercedes');
  const replay = await c.p.next(S.OWNER);
  assert.equal(replay.from, NOBODY);
  assert.deepEqual(ownerOf(replay.body), { netid: ((b.welcome.tag << 20) | 1) >>> 0, owner: sa, previous: sa });
  await c.p.quiet(S.OWNER, 50); // (e: back with the session whose tag it carries — no entry to replay)
});

test('departures and absences: a player\'s entities to the nearest present player within 300 m (its recent states), else orphaned; its locks released', async (t) => {
  const f = fixture(t, { maxPlayers: 4 }), ctx = await serve(t, f);
  const a = await player(ctx, await ctx.account('alice'), 'Tommy'), b = await player(ctx, await ctx.account('bob'), 'Lance');
  const c = await player(ctx, await ctx.account('carol'), 'Mercedes');
  const sa = a.welcome.slot, sb = b.welcome.slot, sc = c.welcome.slot, id = (n) => ((a.welcome.tag << 20) | n) >>> 0;
  b.p.send([C.PLAYER_STATE, pstate(0, 0, 0)]); c.p.send([C.PLAYER_STATE, pstate(100, 0, 0)]);
  await a.p.next(C.PLAYER_STATE); await a.p.next(C.PLAYER_STATE);
  a.p.send([C.ENTITY_STATE, estate(id(3), 0, 1, 0, 0)]); // (stale by the time it leaves)
  await b.p.next(C.ENTITY_STATE);
  ctx.now.skip(16000);
  // (entity 1 near c, 2 near b, 4 far from everyone, 5 given to a by b — the table's, not the tag's)
  const bEntity = ((b.welcome.tag << 20) | 5) >>> 0;
  a.p.send([C.ENTITY_STATE, estate(id(1), 0, 90, 0, 0)], [C.ENTITY_STATE, estate(id(2), 0, 10, 0, 0)], [C.ENTITY_STATE, estate(id(4), 0, 1000, 0, 0)], [C.PLAYER_STATE, pstate(50, 0, 0)]);
  b.p.send([C.ENTITY_STATE, estate(bEntity, 0, 0, 290, 0)], [C.OWN, w().u32(bEntity).u8(2).u8(sa).done()]);
  await c.p.next(S.OWNER);
  a.p.send([C.ENTITY_STATE, estate(bEntity, 0, 0, 290, 0)]);
  await c.p.next(C.ENTITY_STATE); await c.p.next(C.ENTITY_STATE); await c.p.next(C.ENTITY_STATE); await c.p.next(C.ENTITY_STATE);
  // (a lock held by the leaver)
  a.p.send([C.LOCK, w().u16(0x101).done()]);
  await b.p.next(S.RECORD); await c.p.next(S.RECORD);
  b.p.clear(); c.p.clear();
  await a.p.close();
  const expect = new Map([[id(1), sc], [id(2), sb], [id(3), NOBODY], [id(4), NOBODY], [bEntity, sb]]);
  for (const p of [b.p, c.p]) {
    assert.deepEqual([...(await p.next(S.PLAYER_LEAVE)).body], [sa]);
    const rec = recordOf((await p.next(S.RECORD)).body);
    assert.deepEqual([rec.key, rec.holder], [0x101, NOBODY]);
    const got = new Map();
    for (let i = 0; i < expect.size; i++) { const o = ownerOf((await p.next(S.OWNER)).body); assert.equal(o.previous, sa); got.set(o.netid, o.owner); }
    assert.deepEqual(got, expect);
    // (the order: PLAYER_LEAVE, the locks released, the entities handed over)
    assert.deepEqual(p.messages.flat().filter((x) => x !== C.PLAYER_STATE && x !== C.ENTITY_STATE), [S.PLAYER_LEAVE, S.RECORD, ...Array(expect.size).fill(S.OWNER)]);
  }
  // (an orphan's states are nobody's; claimed, it is the claimer's)
  c.p.send([C.ENTITY_STATE, estate(id(4), 0, 1000, 0, 0)]);
  await b.p.quiet(C.ENTITY_STATE);
  c.p.send([C.OWN, w().u32(id(4)).u8(1).u8(NOBODY).done()]);
  assert.deepEqual(ownerOf((await b.p.next(S.OWNER)).body), { netid: id(4), owner: sc, previous: NOBODY });
  // (away: the others told, its entities handed over as it if had left — an away player takes none; back: told)
  const cEntity = ((c.welcome.tag << 20) | 1) >>> 0;
  c.p.send([C.ENTITY_STATE, estate(cEntity, 1, 100, 0, 0)]);
  await b.p.next(C.ENTITY_STATE); b.p.clear();
  c.p.send([C.AWAY, w().u8(1).u8(1).done()]);
  assert.deepEqual([...(await b.p.next(S.PLAYER_AWAY)).body], [sc, 1]);
  const handed = new Map();
  for (let i = 0; i < 3; i++) { const o = ownerOf((await b.p.next(S.OWNER)).body); assert.equal(o.previous, sc); handed.set(o.netid, o.owner); }
  // (c's own entity and the one it got from a: within 300 m of b — the driven one too, its driver away; the claimed
  // orphan 900 m away)
  assert.deepEqual(handed, new Map([[id(1), sb], [cEntity, sb], [id(4), NOBODY]]));
  await b.p.quiet(S.OWNER, 50);
  c.p.send([C.AWAY, w().u8(0).u8(1).done()], [C.AWAY, w().u8(1).u8(0).done()]);
  await b.p.quiet(S.PLAYER_AWAY);
  c.p.send([C.AWAY, w().u8(0).u8(0).done()]);
  assert.deepEqual([...(await b.p.next(S.PLAYER_AWAY)).body], [sc, 0]);
  // (an orphan forgotten after a minute untouched)
  ctx.now.skip(61000);
  for (const p of [b.p, c.p]) p.send([C.PING, w().f64(1).done()]);
  await b.p.next(S.PONG); await c.p.next(S.PONG);
  b.p.clear();
  ctx.server.mmo.sweep();
  // (the entities b was given and said nothing of for a minute: orphaned, everyone told — the contract's 60 s)
  const idle = new Map();
  for (let i = 0; i < 3; i++) { const o = ownerOf((await b.p.next(S.OWNER)).body); idle.set(o.netid, [o.owner, o.previous]); }
  assert.deepEqual(idle, new Map([[id(1), [NOBODY, sb]], [id(2), [NOBODY, sb]], [cEntity, [NOBODY, sb]]]));
  await b.p.quiet(S.OWNER, 50);
  c.p.send([C.ENTITY_STATE, estate(id(4), 0, 1000, 0, 0)]);
  await b.p.quiet(C.ENTITY_STATE);
  c.p.send([C.OWN, w().u32(id(4)).u8(1).u8(NOBODY).done()]);
  assert.deepEqual(ownerOf((await b.p.next(S.OWNER)).body), { netid: id(4), owner: sc, previous: NOBODY }, 'its tag\'s session gone: nobody\'s');
});

test('records and locks: LOCK, STORE by the holder, UNLOCK; replayed after WELCOME; kept while the holder is away', async (t) => {
  const f = fixture(t), ctx = await serve(t, f);
  const a = await player(ctx, await ctx.account('alice'), 'Tommy'), b = await player(ctx, await ctx.account('bob'), 'Lance');
  const sa = a.welcome.slot, key = 0x0105;
  a.p.send([C.LOCK, w().u16(key).done()]);
  for (const p of [a.p, b.p]) { const r = await p.next(S.RECORD); assert.equal(r.from, sa); assert.deepEqual(recordOf(r.body), { key, holder: sa, data: Buffer.alloc(0) }); }
  b.p.send([C.LOCK, w().u16(key).done()]);
  assert.deepEqual(recordOf((await b.p.next(S.RECORD)).body).holder, sa, 'held by another: told who');
  await a.p.quiet(S.RECORD);
  b.p.send([C.STORE, w().u16(key).u16(3).bytes([1, 2, 3]).done()]);
  assert.deepEqual([...(await b.p.next(S.DENIED)).body], [C.STORE, D.INVALID]);
  b.p.send([C.UNLOCK, w().u16(key).done()]);
  assert.deepEqual([...(await b.p.next(S.DENIED)).body], [C.UNLOCK, D.INVALID]);
  const data = Buffer.alloc(160, 0x5a);
  a.p.send([C.LOCK, w().u16(key).done()], [C.STORE, w().u16(key).u16(data.length).bytes(data).done()]);
  await a.p.next(S.RECORD); await b.p.next(S.RECORD);
  for (const p of [a.p, b.p]) assert.deepEqual(recordOf((await p.next(S.RECORD)).body), { key, holder: NOBODY, data });
  a.p.send([C.STORE, w().u16(key).u16(4097).bytes(Buffer.alloc(4097)).done()]);
  assert.deepEqual([...(await a.p.next(S.DENIED)).body], [C.STORE, D.INVALID]);
  // (UNLOCK by the holder: free again, data kept)
  b.p.send([C.LOCK, w().u16(key).done()]);
  await a.p.next(S.RECORD); await b.p.next(S.RECORD);
  b.p.send([C.UNLOCK, w().u16(key).done()]);
  assert.deepEqual(recordOf((await a.p.next(S.RECORD)).body), { key, holder: NOBODY, data });
  // (the holder away — its pause menu, its tab hidden —: its locks stay its own, what it took out under them is still in
  // its game; the others still told who holds them)
  ctx.now.skip(2000);
  b.p.send([C.LOCK, w().u16(key).done()], [C.LOCK, w().u16(7).done()]);
  await a.p.next(S.RECORD); await a.p.next(S.RECORD); a.p.clear();
  b.p.send([C.AWAY, w().u8(1).u8(1).done()]);
  await a.p.next(S.PLAYER_AWAY);
  await a.p.quiet(S.RECORD);
  ctx.now.skip(2000);
  a.p.send([C.LOCK, w().u16(key).done()]);
  assert.equal(recordOf((await a.p.next(S.RECORD)).body).holder, b.welcome.slot, 'still b\'s');
  // (back, and stored: the record as b's game has it)
  b.p.send([C.AWAY, w().u8(1).u8(0).done()], [C.STORE, w().u16(key).u16(data.length).bytes(data).done()], [C.UNLOCK, w().u16(7).done()]);
  await a.p.next(S.PLAYER_AWAY);
  assert.deepEqual(recordOf((await a.p.next(S.RECORD)).body), { key, holder: NOBODY, data });
  assert.deepEqual(recordOf((await a.p.next(S.RECORD)).body), { key: 7, holder: NOBODY, data: Buffer.alloc(0) }, 'an empty record let go: forgotten');
  // (a newcomer: every record after WELCOME — with data or a holder)
  a.p.send([C.LOCK, w().u16(9).done()]);
  await a.p.next(S.RECORD);
  const c = await player(ctx, await ctx.account('carol'), 'Mercedes');
  const replay = [recordOf((await c.p.next(S.RECORD)).body), recordOf((await c.p.next(S.RECORD)).body)];
  assert.deepEqual(replay, [{ key: 9, holder: sa, data: Buffer.alloc(0) }, { key, holder: NOBODY, data }]);
  await c.p.quiet(S.RECORD, 50);
});

test('chat: everyone in the world (the sender too), its text\'s rules, at most one a second (bursts of 5), the last 20 lines for a newcomer', async (t) => {
  const f = fixture(t), ctx = await serve(t, f);
  const a = await player(ctx, await ctx.account('alice'), 'Tommy'), b = await player(ctx, await ctx.account('bob'), 'Lance');
  a.p.send([C.CHAT, w().str8('hello \xe9t\xe9!').done()]);
  for (const p of [a.p, b.p]) { const r = await p.next(S.CHAT); assert.equal(r.from, a.welcome.slot); assert.deepEqual(chatOf(r.body), { kind: 0, name: 'Tommy', text: 'hello \xe9t\xe9!' }); }
  for (const bad of [Buffer.alloc(0), Buffer.alloc(121, 0x41), Buffer.from('bell\x07'), Buffer.from([0x41, 0x80]), Buffer.from([0x41, 0x9f])]) {
    a.p.send([C.CHAT, w().u8(bad.length).bytes(bad).done()]);
    assert.deepEqual([...(await a.p.next(S.DENIED)).body], [C.CHAT, D.INVALID]);
  }
  assert.equal((await (async () => { a.p.send([C.CHAT, w().str8('x'.repeat(120)).done()]); return chatOf((await b.p.next(S.CHAT)).body).text.length; })()), 120);
  // (the bucket: 5 at once, then one a second — 2 used already)
  for (let i = 0; i < 4; i++) a.p.send([C.CHAT, w().str8(`burst ${i}`).done()]);
  for (let i = 0; i < 3; i++) await b.p.next(S.CHAT);
  assert.deepEqual([...(await a.p.next(S.DENIED)).body], [C.CHAT, D.RATE]);
  await b.p.quiet(S.CHAT);
  for (let i = 0; i < 25; i++) { ctx.now.skip(1000); b.p.send([C.CHAT, w().str8(`line ${i}`).done()]); await a.p.next(S.CHAT); }
  // (not in a world: denied)
  const lobbyOnly = await Peer.open(ctx, await ctx.account('dave')); await hello(lobbyOnly);
  lobbyOnly.send([C.CHAT, w().str8('hi').done()]);
  assert.deepEqual([...(await lobbyOnly.next(S.DENIED)).body], [C.CHAT, D.INVALID]);
  // (a newcomer: WELCOME, the records, the last 20 lines, from the server)
  a.p.send([C.LOCK, w().u16(1).done()]);
  await a.p.next(S.RECORD);
  const c = await player(ctx, await ctx.account('carol'), 'Mercedes');
  const lines = [];
  for (let i = 0; i < 20; i++) { const r = await c.p.next(S.CHAT); assert.equal(r.from, NOBODY); lines.push(chatOf(r.body).text); }
  assert.deepEqual(lines, Array.from({ length: 20 }, (_, i) => `line ${i + 5}`));
  await c.p.quiet(S.CHAT, 50);
  const order = c.p.messages.flat();
  assert.deepEqual(order.slice(order.indexOf(S.WELCOME), order.indexOf(S.WELCOME) + 22), [S.WELCOME, S.RECORD, ...Array(20).fill(S.CHAT)], 'WELCOME, records, chat history');
});

test('world changes: WORLD_SET and WORLD_EVENT from admins only (admins.json, read again when it changes), WORLD to everyone', async (t) => {
  const f = fixture(t), ctx = await serve(t, f);
  fs.mkdirSync(f.mmoDir, { recursive: true });
  fs.writeFileSync(path.join(f.mmoDir, 'admins.json'), JSON.stringify(['Boss']));
  const boss = await ctx.account('boss');
  assert.equal((await (await fetch(`${ctx.base}/api/mmo/city-online`, { headers: { Cookie: boss } })).json()).admin, true);
  const lobby = await hello(await Peer.open(ctx, boss));
  assert.equal(lobby.admin, 1);
  const a = await player(ctx, boss, 'Tommy'), b = await player(ctx, await ctx.account('bob'), 'Lance');
  assert.equal(a.welcome.admin, 1); assert.equal(b.welcome.admin, 0);
  assert.deepEqual(b.welcome.players.map((p) => p.admin), [1, 0]);
  b.p.send([C.WORLD_SET, w().u8(1).u8(1).i32(3).done()], [C.WORLD_EVENT, w().u8(1).i32(0).done()]);
  assert.deepEqual([...(await b.p.next(S.DENIED)).body], [C.WORLD_SET, D.NOT_ADMIN]);
  assert.deepEqual([...(await b.p.next(S.DENIED)).body], [C.WORLD_EVENT, D.NOT_ADMIN]);
  await a.p.quiet(S.WORLD);
  a.p.send([C.WORLD_SET, w().u8(1).u8(1).i32(-1).done()]);
  for (const p of [a.p, b.p]) { const r = await p.next(S.WORLD); assert.equal(r.from, a.welcome.slot); assert.deepEqual(worldOf(rd(r.body)).vars, { 1: -1 }); }
  a.p.send([C.WORLD_SET, w().u8(1).u8(2).i32(0x15).done()], [C.WORLD_SET, w().u8(2).u16(300).done()]);
  await b.p.next(S.WORLD);
  const set = worldOf(rd((await b.p.next(S.WORLD)).body));
  assert.deepEqual(set.vars, { 1: -1, 2: 0x15 });
  assert.equal(set.baseMinutes, 300, 'the same day (0), at 05:00'); assert.ok(Math.abs(set.baseMs - ctx.now()) < 1000);
  a.p.send([C.WORLD_SET, w().u8(3).f32(500).done()]);
  const fast = worldOf(rd((await b.p.next(S.WORLD)).body));
  assert.equal(fast.msPerMinute, 500); assert.ok(fast.baseMinutes >= 300 && fast.baseMinutes < 301);
  for (const bad of [w().u8(3).f32(10).done(), w().u8(3).f32(NaN).done(), w().u8(2).u16(1440).done(), w().u8(9).done(), w().u8(1).u8(1).done()]) {
    a.p.send([C.WORLD_SET, bad]);
    assert.deepEqual([...(await a.p.next(S.DENIED)).body], [C.WORLD_SET, D.INVALID]);
  }
  a.p.send([C.WORLD_EVENT, w().u8(1).i32(-7).done()]);
  for (const p of [a.p, b.p]) { const r = await p.next(S.WORLD_EVENT); assert.equal(r.from, a.welcome.slot); assert.deepEqual([r.body[0], r.body.readInt32LE(1)], [1, -7]); }
  // (no longer an admin: refused at once)
  fs.writeFileSync(path.join(f.mmoDir, 'admins.json'), JSON.stringify(['someone-else']));
  a.p.send([C.WORLD_EVENT, w().u8(1).i32(0).done()]);
  assert.deepEqual([...(await a.p.next(S.DENIED)).body], [C.WORLD_EVENT, D.NOT_ADMIN]);
});

test('the world\'s clock runs only while someone is there; characters, world variables and records survive a restart', async (t) => {
  const f = fixture(t);
  let ctx = await serve(t, f);
  const alice = await ctx.account('alice');
  fs.mkdirSync(f.mmoDir, { recursive: true });
  fs.writeFileSync(path.join(f.mmoDir, 'admins.json'), JSON.stringify(['alice']));
  let a = await player(ctx, alice, 'Tommy', 'ply_1');
  assert.equal(a.welcome.world.baseMinutes, 720);
  ctx.now.skip(30000); // (30 game minutes)
  const state = Buffer.from(Array.from({ length: 300 }, (_, i) => i & 255));
  a.p.send([C.CHAR_SAVE, w().i32(4900).u16(state.length).bytes(state).done()], [C.WORLD_SET, w().u8(1).u8(1).i32(4).done()],
    [C.LOCK, w().u16(0x110).done()], [C.STORE, w().u16(0x110).u16(2).bytes([8, 9]).done()], [C.PLAYER_INFO, w().str8('ply_2').done()]);
  await a.p.next(S.WORLD); await a.p.next(S.RECORD); await a.p.next(S.RECORD);
  ctx.now.skip(250); a.p.send([C.LEAVE]);
  await a.p.next(S.LEFT);
  const lobby = lobbyOf((await a.p.next(S.LOBBY)).body);
  assert.deepEqual(lobby.characters, [{ id: a.id, name: 'Tommy', skin: 'ply_2', money: 4900, online: 0 }]);
  // (nobody there: saved and frozen — 10 hours later, the same minute)
  const saved = JSON.parse(fs.readFileSync(path.join(f.mmoDir, 'city-online', 'world.json'), 'utf8'));
  assert.ok(Math.abs(saved.minutes - 750) < 0.5, `minutes ${saved.minutes}`);
  assert.deepEqual([saved.msPerMinute, saved.vars, saved.records], [1000, { 1: 4 }, { [0x110]: Buffer.from([8, 9]).toString('base64') }]);
  await a.p.close();
  ctx.now.skip(10 * 3600e3);
  a = await player(ctx, alice, 'Tommy');
  assert.ok(Math.abs(a.welcome.world.baseMinutes - 750) < 0.5, `frozen while empty: ${a.welcome.world.baseMinutes}`);
  assert.ok(Math.abs(a.welcome.world.baseMs - ctx.now()) < 1000);
  // (a restart: everything flushed when the server closes, read back by the next one)
  a.p.send([C.CHAR_SAVE, w().i32(-5).u16(state.length).bytes(state).done()], [C.PING, w().f64(0).done()]);
  await a.p.next(S.PONG);
  await ctx.close();
  await a.p.done;
  const files = fs.readdirSync(path.join(f.mmoDir, 'city-online')).sort();
  assert.deepEqual(files, ['characters.json', 'world.json'], 'no temporary file left');
  const chars = JSON.parse(fs.readFileSync(path.join(f.mmoDir, 'city-online', 'characters.json'), 'utf8'));
  assert.equal(chars.characters[0].user.length, 36, 'the account\'s id');
  assert.deepEqual([chars.characters[0].money, Buffer.from(chars.characters[0].state, 'base64')], [-5, state]);
  ctx = await serve(t, f);
  const back = await player(ctx, alice, 'Tommy');
  assert.deepEqual([back.welcome.charId, back.welcome.skin, back.welcome.state, back.welcome.world.vars], [a.id, 'ply_2', state, { 1: 4 }]);
  assert.ok(back.welcome.world.baseMinutes >= 750 && back.welcome.world.baseMinutes < 752);
  assert.deepEqual(recordOf((await back.p.next(S.RECORD)).body), { key: 0x110, holder: NOBODY, data: Buffer.from([8, 9]) });
  assert.equal(lobbyOf((await (async () => { ctx.now.skip(250); back.p.send([C.HELLO, w().u16(1).done()]); return back.p.next(S.LOBBY); })()).body).characters[0].money, -5);
  // (--mmo elsewhere: its own directory)
  const other = path.join(f.root, 'elsewhere');
  const ctx2 = await serve(t, f, { mmoDir: other });
  const c2 = await player(ctx2, alice, 'Tommy');
  assert.equal(c2.welcome.world.baseMinutes, 720);
  await ctx2.close();
  assert.ok(fs.existsSync(path.join(other, 'city-online', 'characters.json')));
});

test('limits: messages over 64 KB close, records and bytes a second, lobby requests a second; silence and signed-out sessions closed', async (t) => {
  const f = fixture(t), ctx = await serve(t, f);
  const alice = await ctx.account('alice');
  const a = await player(ctx, alice, 'Tommy'), b = await player(ctx, await ctx.account('bob'), 'Lance');
  // (records: 800 a second, 1600 at once)
  const many = Array.from({ length: 1700 }, (_, i) => [C.EVENT, w().u8(i & 255).done()]);
  a.p.send(...many.slice(0, 900)); a.p.send(...many.slice(900));
  assert.deepEqual([...(await a.p.next(S.DENIED)).body], [C.EVENT, D.RATE]);
  await sleep(200);
  assert.equal(b.p.inbox.filter((r) => r.type === C.EVENT).length, 1600);
  assert.equal(a.p.inbox.filter((r) => r.type === S.DENIED).length, 0, 'one DENIED a second at most');
  b.p.clear();
  // (bytes: 256 KB a second, 512 KB at once)
  ctx.now.skip(5000);
  const big = w().u8(1).bytes(Buffer.alloc(1000)).done();
  for (let i = 0; i < 10; i++) a.p.send(...Array(60).fill([C.EVENT, big]));
  assert.deepEqual([...(await a.p.next(S.DENIED)).body], [C.EVENT, D.RATE]);
  await sleep(200);
  assert.equal(b.p.inbox.filter((r) => r.type === C.EVENT).length, Math.floor(512 * 1024 / 1004), 'records of 1004 bytes (with their header)');
  // (lobby requests: 5 a second)
  ctx.now.skip(5000);
  a.p.clear();
  a.p.send(...Array(6).fill([C.HELLO, w().u16(1).u8(0).done()]));
  assert.deepEqual([...(await a.p.next(S.DENIED)).body], [C.HELLO, D.RATE]);
  assert.equal(a.p.inbox.filter((r) => r.type === S.LOBBY).length, 5);
  // (a message over 64 KB: closed)
  const c = await Peer.open(ctx, alice);
  c.ws.send(Buffer.alloc(65537));
  await c.done;
  // (malformed framing: REFUSED 4)
  const d = await Peer.open(ctx, alice);
  d.ws.send(Buffer.from([10, 0, C.PING]));
  assert.equal((await d.next(S.REFUSED)).body[0], R.PROTOCOL);
  await d.done;
  // (silent for 45 s: closed — the page pings every 15)
  const e = await Peer.open(ctx, alice); await hello(e);
  ctx.now.skip(30000);
  for (const p of [a.p, b.p]) p.send([C.PING, w().f64(0).done()]);
  await a.p.next(S.PONG); await b.p.next(S.PONG);
  ctx.now.skip(16000);
  for (const p of [a.p, b.p]) p.send([C.PING, w().f64(0).done()]);
  await a.p.next(S.PONG); await b.p.next(S.PONG);
  ctx.server.mmo.sweep();
  await e.done;
  assert.equal(a.p.closed || b.p.closed, false);
  // (signed out: told at the next check, within a minute)
  await fetch(ctx.base + '/api/account/logout', { method: 'POST', headers: { Origin: ctx.base, Cookie: alice } });
  ctx.now.skip(30000);
  for (const p of [a.p, b.p]) p.send([C.PING, w().f64(0).done()]);
  await a.p.next(S.PONG); await b.p.next(S.PONG);
  b.p.clear();
  ctx.server.mmo.sweep();
  assert.equal((await a.p.next(S.REFUSED)).body[0], R.SIGN_IN);
  await a.p.done;
  assert.deepEqual([...(await b.p.next(S.PLAYER_LEAVE)).body], [a.welcome.slot]);
  assert.equal(b.p.closed, false);
});

test('more of the world: CHAR_SAVE and PLAYER_INFO in a world only, an away player joins as away, LEAVE outside a world', async (t) => {
  const f = fixture(t), ctx = await serve(t, f);
  const alice = await ctx.account('alice');
  const a = await Peer.open(ctx, alice);
  a.send([C.AWAY, w().u8(1).u8(1).done()]);
  const lobby = await hello(a);
  a.send([C.CHAR_SAVE, w().i32(1).u16(0).done()]);
  assert.deepEqual([...(await a.next(S.DENIED)).body], [C.CHAR_SAVE, D.INVALID]);
  ctx.now.skip(250); a.send([C.LEAVE]);
  await a.next(S.LEFT); await a.next(S.LOBBY);
  const id = lobby.characters[0]?.id ?? (await create(ctx, a, 'Tommy')).id;
  const wa = await join(ctx, a, id);
  assert.equal(wa.players[0].away, 1, 'away before joining: away in the world');
  const b = await player(ctx, await ctx.account('bob'), 'Lance');
  assert.equal(b.welcome.players.find((p) => p.slot === wa.slot).away, 1);
  a.send([C.PLAYER_INFO, w().str8('bad skin').done()]);
  assert.deepEqual([...(await a.next(S.DENIED)).body], [C.PLAYER_INFO, D.INVALID]);
  a.send([C.PLAYER_INFO, w().str8('hfyst').done()]);
  const info = await b.p.next(S.PLAYER_INFO);
  assert.equal(info.from, wa.slot); assert.deepEqual([info.body[0], rd(info.body.subarray(1)).str8()], [wa.slot, 'hfyst']);
  await a.quiet(S.PLAYER_INFO);
  a.send([C.CHAR_SAVE, w().i32(1).u16(4097).bytes(Buffer.alloc(4097)).done()]);
  assert.deepEqual([...(await a.next(S.DENIED)).body], [C.CHAR_SAVE, D.INVALID]);
  // (a character's skin changed from the lobby while in the world: the others told)
  const skin = await lobbyRequest(ctx, a, C.CHAR_SKIN, w().u32(id).str8('ply_3').done());
  assert.equal(skin.status, CR.OK);
  assert.equal(rd((await b.p.next(S.PLAYER_INFO)).body.subarray(1)).str8(), 'ply_3');
});

/** A WebSocket over a raw socket, to stop reading at will: its records counted by type once it reads again. */
function slowPeer(ctx, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${ctx.base}/api/mmo/city-online/ws`, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', Origin: ctx.base, Cookie: cookie, 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': randomBytes(16).toString('base64') } });
    req.on('error', reject);
    req.on('upgrade', (_res, socket, head) => {
      let buf = head;
      const counts = new Map();
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        while (buf.length >= 2) {
          let len = buf[1] & 127, o = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); o = 10; }
          if (buf.length < o + len) return;
          const msg = buf.subarray(o, o + len), op = buf[0] & 15; buf = buf.subarray(o + len);
          if (op === 2) for (const r of mmoServerRecords(msg)) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
        }
      });
      resolve({
        socket, counts,
        send(...records) {
          const data = Buffer.concat(records.map(([type, body]) => mmoClientRecord(type, body ?? Buffer.alloc(0)))), mask = randomBytes(4);
          const h = data.length < 126 ? Buffer.from([0x82, 0x80 | data.length]) : Buffer.from([0x82, 0x80 | 126, data.length >> 8, data.length & 255]);
          for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
          socket.write(Buffer.concat([h, mask, data]));
        },
      });
    });
  });
}

test('a message cut in frames is limited as a whole (lan.js maxMessage): 64 KB in all closes the connection', async (t) => {
  const f = fixture(t), ctx = await serve(t, f);
  const raw = await slowPeer(ctx, await ctx.account('alice'));
  const closed = new Promise((r) => raw.socket.on('close', r));
  const frame = (fin, op, data) => { const mask = randomBytes(4), d = Buffer.from(data); for (let i = 0; i < d.length; i++) d[i] ^= mask[i & 3]; return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, 0x80 | 126, d.length >> 8, d.length & 255]), mask, d]); };
  // (fragments within the limit, a ping between them: one message of 3 records)
  const ping = mmoClientRecord(C.PING, w().f64(1).done());
  raw.socket.write(Buffer.concat([frame(false, 2, mmoClientRecord(C.HELLO, w().u16(1).u8(0).done())), frame(false, 0, ping), Buffer.from([0x89, 0x80, 1, 2, 3, 4]), frame(true, 0, ping)]));
  const deadline = Date.now() + 3000;
  while ((raw.counts.get(S.PONG) ?? 0) < 2 && Date.now() < deadline) await sleep(20);
  assert.deepEqual([raw.counts.get(S.LOBBY), raw.counts.get(S.PONG)], [1, 2]);
  raw.socket.write(Buffer.concat([frame(false, 2, Buffer.alloc(40000)), frame(true, 0, Buffer.alloc(30000))]));
  await closed;
});

test('a player that stops reading: its realtime records dropped once 1 MB waits for it, the others still sent', async (t) => {
  const f = fixture(t), ctx = await serve(t, f);
  const alice = await ctx.account('alice'), bob = await ctx.account('bob');
  const a = await player(ctx, alice, 'Tommy');
  const b = await Peer.open(ctx, bob); await hello(b);
  const id = (await create(ctx, b, 'Lance')).id;
  await b.close();
  const slow = await slowPeer(ctx, bob);
  ctx.now.skip(1000);
  slow.send([C.HELLO, w().u16(1).u8(0).done()], [C.JOIN, w().u32(id).done()]);
  await a.p.next(S.PLAYER_JOIN);
  slow.socket.pause();
  const state = w().f32(1).f32(2).f32(3).bytes(Buffer.alloc(240, 1)).done();
  let sent = 0;
  for (let round = 0; round < 40; round++) {
    ctx.now.skip(2000);
    for (let m = 0; m < 7; m++) { a.p.send(...Array(200).fill([C.PLAYER_STATE, state])); sent += 200; } // (1400: within a round's 1600 records, the PING too)
    a.p.send([C.PING, w().f64(round).done()]);
    await a.p.next(S.PONG);
  }
  a.p.send([C.CHAT, w().str8('still there?').done()], [C.PING, w().f64(-1).done()]);
  await a.p.next(S.CHAT); await a.p.next(S.PONG);
  slow.socket.resume();
  const deadline = Date.now() + 10000;
  while (!slow.counts.get(S.CHAT) && Date.now() < deadline) await sleep(50);
  await sleep(100);
  const got = slow.counts.get(C.PLAYER_STATE) ?? 0;
  assert.equal(slow.counts.get(S.CHAT), 1, 'control records go through');
  assert.ok(got > 1000 && got < sent, `${got} of ${sent} realtime records: the rest dropped`);
});

test('a departed holder\'s locks: kept for its character (its game may still hold what it took out), given back at its JOIN; not after LEAVE; for two minutes at most', async (t) => {
  const f = fixture(t), ctx = await serve(t, f);
  const alice = await ctx.account('alice'), bob = await ctx.account('bob');
  let a = await player(ctx, alice, 'Tommy');
  const b = await player(ctx, bob, 'Lance');
  const key = 0x0102, cars = Buffer.alloc(160, 0x33);
  // (a's garage: its record stored, then opened again — the cars out in a's game, the record still listing them)
  a.p.send([C.LOCK, w().u16(key).done()], [C.STORE, w().u16(key).u16(cars.length).bytes(cars).done()], [C.LOCK, w().u16(key).done()]);
  for (let i = 0; i < 3; i++) await b.p.next(S.RECORD);
  // (its connection lost: the others see the lock free, nobody gets it)
  await a.p.close();
  await b.p.next(S.PLAYER_LEAVE);
  assert.deepEqual(recordOf((await b.p.next(S.RECORD)).body), { key, holder: NOBODY, data: cars });
  b.p.send([C.LOCK, w().u16(key).done()]);
  assert.deepEqual([...(await b.p.next(S.DENIED)).body], [C.LOCK, D.INVALID], 'kept for a\'s character');
  // (a back as the same character: the lock is its again, everyone told — its STORE of what came back in goes through)
  a = await player(ctx, alice, 'Tommy');
  const back = await b.p.next(S.RECORD);
  assert.deepEqual([back.from, recordOf(back.body).holder], [a.welcome.slot, a.welcome.slot]);
  const mine = [recordOf((await a.p.next(S.RECORD)).body), recordOf((await a.p.next(S.RECORD)).body)];
  assert.deepEqual(mine.map((r) => r.holder), [NOBODY, a.welcome.slot], 'the replay, then the lock given back');
  const less = Buffer.alloc(160, 0x11);
  a.p.send([C.STORE, w().u16(key).u16(less.length).bytes(less).done()]);
  assert.deepEqual(recordOf((await b.p.next(S.RECORD)).body), { key, holder: NOBODY, data: less });
  // (LEAVE: its game left the world, nothing out — the lock free for everyone at once)
  a.p.send([C.LOCK, w().u16(key).done()]);
  await b.p.next(S.RECORD);
  ctx.now.skip(250); a.p.send([C.LEAVE]);
  await a.p.next(S.LEFT);
  assert.equal(recordOf((await b.p.next(S.RECORD)).body).holder, NOBODY);
  b.p.send([C.LOCK, w().u16(key).done()]);
  assert.equal(recordOf((await b.p.next(S.RECORD)).body).holder, b.welcome.slot);
  b.p.send([C.UNLOCK, w().u16(key).done()]);
  await b.p.next(S.RECORD);
  // (kept two minutes at most)
  const c = await player(ctx, await ctx.account('carol'), 'Mercedes');
  c.p.send([C.LOCK, w().u16(key).done()]);
  await b.p.next(S.RECORD);
  await c.p.close();
  await b.p.next(S.RECORD);
  ctx.now.skip(60000);
  b.p.send([C.LOCK, w().u16(key).done()]);
  assert.deepEqual([...(await b.p.next(S.DENIED)).body], [C.LOCK, D.INVALID]);
  ctx.now.skip(61000);
  b.p.send([C.PING, w().f64(0).done()]); await b.p.next(S.PONG);
  ctx.server.mmo.sweep();
  b.p.send([C.LOCK, w().u16(key).done()]);
  assert.equal(recordOf((await b.p.next(S.RECORD)).body).holder, b.welcome.slot);
});

test('records\' limits: LOCK/STORE/UNLOCK 4 a second (8 at once); keys the version declares; locks a player holds, records a character stored, a world\'s data', async (t) => {
  const f = fixture(t, { maxPlayers: 3, records: [[0, 99], [256, 267]] });
  const ctx = await serve(t, f);
  const a = await player(ctx, await ctx.account('alice'), 'Tommy'), b = await player(ctx, await ctx.account('bob'), 'Lance');
  // (a burst: 8, then denied)
  for (let i = 0; i < 9; i++) a.p.send([i % 2 ? C.UNLOCK : C.LOCK, w().u16(256).done()]);
  for (let i = 0; i < 8; i++) await b.p.next(S.RECORD);
  assert.deepEqual([...(await a.p.next(S.DENIED)).body], [C.LOCK, D.RATE]);
  await b.p.quiet(S.RECORD);
  // (keys outside the version's ranges: denied)
  ctx.now.skip(2000);
  a.p.send([C.LOCK, w().u16(100).done()], [C.LOCK, w().u16(0x0300).done()]);
  assert.deepEqual([...(await a.p.next(S.DENIED)).body], [C.LOCK, D.INVALID]);
  await b.p.quiet(S.RECORD);
  // (16 locks held at once)
  a.p.clear();
  for (let k = 0; k < 16; k++) { ctx.now.skip(250); a.p.send([C.LOCK, w().u16(k).done()]); assert.equal(recordOf((await b.p.next(S.RECORD)).body).key, k); }
  ctx.now.skip(250); a.p.send([C.LOCK, w().u16(16).done()]);
  assert.deepEqual([...(await a.p.next(S.DENIED)).body], [C.LOCK, D.INVALID]);
  // (16 records with data per character: the 17th STORE denied — 15 stored here, one more on a key it then frees)
  for (let k = 0; k < 16; k++) { ctx.now.skip(250); a.p.send([C.STORE, w().u16(k).u16(1).bytes([k]).done()]); assert.equal(recordOf((await b.p.next(S.RECORD)).body).data[0], k); }
  ctx.now.skip(250); a.p.send([C.LOCK, w().u16(20).done()]); await b.p.next(S.RECORD);
  ctx.now.skip(250); a.p.send([C.STORE, w().u16(20).u16(1).bytes([1]).done()]);
  assert.deepEqual([...(await a.p.next(S.DENIED)).body], [C.STORE, D.INVALID]);
  // (an empty STORE frees a key: the character may store again)
  ctx.now.skip(250); a.p.send([C.LOCK, w().u16(3).done()]); await b.p.next(S.RECORD);
  ctx.now.skip(250); a.p.send([C.STORE, w().u16(3).u16(0).done()]);
  assert.deepEqual(recordOf((await b.p.next(S.RECORD)).body), { key: 3, holder: NOBODY, data: Buffer.alloc(0) });
  ctx.now.skip(250); a.p.send([C.STORE, w().u16(20).u16(1).bytes([1]).done()]);
  assert.equal(recordOf((await b.p.next(S.RECORD)).body).key, 20);
  // (the world's data: 1 MB together — characters each within theirs, the world full all the same)
  await ctx.close();
  const raw = JSON.parse(fs.readFileSync(path.join(f.mmoDir, 'city-online', 'world.json'), 'utf8'));
  assert.equal(Object.keys(raw.records).length, 16);
  assert.equal(Object.values(raw.recordsBy).every((id) => id === a.id), true, 'who stored each, kept');
  // (a world.json over 1 MB of records: what fits is loaded)
  const big = Buffer.alloc(4096, 7).toString('base64'), preset = {};
  for (let k = 0; k < 300; k++) preset[k] = big;
  const g = fixture(t, { maxPlayers: 3 });
  fs.mkdirSync(path.join(g.mmoDir, 'city-online'), { recursive: true });
  fs.writeFileSync(path.join(g.mmoDir, 'city-online', 'world.json'), JSON.stringify({ minutes: 720, msPerMinute: 1000, vars: {}, records: preset }));
  const ctx2 = await serve(t, g);
  const c = await player(ctx2, await ctx2.account('carol'), 'Mercedes');
  await sleep(100);
  assert.equal(c.p.inbox.filter((r) => r.type === S.RECORD).length, 256, '1 MB of records loaded, the rest left out');
  c.p.clear();
  c.p.send([C.LOCK, w().u16(1000).done()]); await c.p.next(S.RECORD);
  c.p.send([C.STORE, w().u16(1000).u16(1).bytes([1]).done()]);
  assert.deepEqual([...(await c.p.next(S.DENIED)).body], [C.STORE, D.INVALID]);
  c.p.send([C.STORE, w().u16(5).u16(1).bytes([1]).done()]);
  assert.deepEqual([...(await c.p.next(S.DENIED)).body], [C.STORE, D.INVALID], 'not the holder');
  c.p.send([C.LOCK, w().u16(5).done()], [C.STORE, w().u16(5).u16(10).bytes(Buffer.alloc(10)).done()]);
  await c.p.next(S.RECORD);
  assert.deepEqual(recordOf((await c.p.next(S.RECORD)).body), { key: 5, holder: NOBODY, data: Buffer.alloc(10) }, 'smaller: within the world\'s data');
});

test('an unreadable characters.json or world.json is never taken for an empty one: refused, read again at the next try', async (t) => {
  const f = fixture(t), dir = path.join(f.mmoDir, 'city-online');
  fs.mkdirSync(path.join(dir, 'characters.json'), { recursive: true }); // (EISDIR: as EIO or EMFILE would)
  const ctx = await serve(t, f);
  const alice = await ctx.account('alice');
  const p = await Peer.open(ctx, alice);
  assert.equal((await p.next(S.REFUSED)).body[0], R.ERROR);
  await p.done;
  assert.ok(fs.statSync(path.join(dir, 'characters.json')).isDirectory(), 'left as it was');
  fs.rmdirSync(path.join(dir, 'characters.json'));
  const userId = (await (await fetch(`${ctx.base}/api/account`, { headers: { Cookie: alice } })).json()).user?.id;
  fs.writeFileSync(path.join(dir, 'characters.json'), JSON.stringify({ nextId: 8, characters: [{ id: 7, user: userId ?? 'x', name: 'Kept', skin: 'player', money: 5 }] }));
  fs.mkdirSync(path.join(dir, 'world.json'));
  const q = await Peer.open(ctx, alice);
  const lobby = await hello(q);
  if (userId) assert.deepEqual(lobby.characters.map((c) => c.name), ['Kept'], 'read again: not cached empty');
  const id = userId ? 7 : (await create(ctx, q, 'Tommy')).id;
  ctx.now.skip(250); q.send([C.JOIN, w().u32(id).done()]);
  assert.deepEqual(resultOf((await q.next(S.CHAR_RESULT)).body), { op: 5, status: CR.ERROR, id });
  fs.rmdirSync(path.join(dir, 'world.json'));
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({ minutes: 100, msPerMinute: 1000, vars: { 3: 9 }, records: {} }));
  const welcome = await join(ctx, q, id);
  assert.deepEqual([Math.floor(welcome.world.baseMinutes), welcome.world.vars], [100, { 3: 9 }]);
});

test('admins are accounts: a listed name is bound to the first account signed in under it; a new account of that name is none', async (t) => {
  const f = fixture(t), ctx = await serve(t, f);
  fs.mkdirSync(f.mmoDir, { recursive: true });
  fs.writeFileSync(path.join(f.mmoDir, 'admins.json'), JSON.stringify(['Boss']));
  const status = async (cookie) => (await (await fetch(`${ctx.base}/api/mmo/city-online`, { headers: { Cookie: cookie } })).json()).admin;
  const boss = await ctx.account('boss');
  assert.equal(await status(boss), true);
  const bound = JSON.parse(fs.readFileSync(path.join(f.mmoDir, 'admin-ids.json'), 'utf8'));
  assert.equal(typeof bound.boss, 'string');
  const del = await fetch(`${ctx.base}/api/account`, { method: 'DELETE', headers: { Origin: ctx.base, 'Content-Type': 'application/json', Cookie: boss }, body: JSON.stringify({ password: 'orthros-test-password' }) });
  assert.equal(del.status, 200);
  const again = await ctx.account('boss');
  assert.equal(await status(again), false, 'the name registered again: not the admin');
  // ({ name, id } entries: that account only)
  fs.writeFileSync(path.join(f.mmoDir, 'admins.json'), JSON.stringify([{ name: 'boss', id: 'someone-else' }, { name: 'Chief', id: bound.boss }]));
  assert.equal(await status(again), false);
  const chief = await ctx.account('chief');
  assert.equal(await status(chief), false, 'the id is another account\'s');
});

test('connections: two outside the world per account; at the version\'s limit the idlest outside the world makes room; no HELLO in 10 s closed; pongs are signs of life', async (t) => {
  const f = fixture(t, { maxCharacters: 2, maxPlayers: 2 }), ctx = await serve(t, f); // (8 connections at most)
  const alice = await ctx.account('alice');
  const l1 = await Peer.open(ctx, alice); await hello(l1);
  const l2 = await Peer.open(ctx, alice); await hello(l2);
  const l3 = await Peer.open(ctx, alice); await hello(l3);
  assert.equal((await l1.next(S.REFUSED)).body[0], R.ELSEWHERE, 'a third outside the world: the oldest goes');
  assert.equal(l2.closed, false);
  // (others fill the version: 7 connections, then 8 with one in the world)
  const others = [];
  for (const [name, n] of [['bob', 2], ['carol', 2], ['dave', 1]]) { const c = await ctx.account(name); for (let i = 0; i < n; i++) { ctx.now.skip(10); const p = await Peer.open(ctx, c); await hello(p); others.push(p); } }
  ctx.now.skip(10);
  const inWorld = await player(ctx, await ctx.account('erin'), 'Erin');
  assert.equal([l2, l3, ...others].some((p) => p.closed), false);
  // (l2 has been idle the longest outside the world: closed for a newcomer, who is let in)
  ctx.now.skip(10);
  l3.send([C.PING, w().f64(0).done()]); await l3.next(S.PONG);
  const late = await Peer.open(ctx, await ctx.account('frank'));
  assert.equal((await l2.next(S.REFUSED)).body[0], R.FULL);
  await hello(late);
  assert.equal([l3, inWorld.p, ...others].some((p) => p.closed), false, 'only the idlest closed, never one in the world');
  // (no HELLO within 10 s: closed — not refused, a page connects again if it wants)
  const mute = await Peer.open(ctx, await ctx.account('gina'));
  await l2.done;
  ctx.now.skip(11000);
  for (const p of [l3, late, inWorld.p, ...others]) if (!p.closed) { p.send([C.PING, w().f64(0).done()]); await p.next(S.PONG); }
  ctx.server.mmo.sweep();
  await mute.done;
  assert.equal(mute.inbox.filter((r) => r.type === S.REFUSED).length, 0);
  assert.equal(late.closed, false);
  // (a peer that sends nothing for 46 s but answers the server's pings stays)
  ctx.now.skip(30000);
  ctx.server.mmo.sweep(); // (pings)
  await sleep(150);
  ctx.now.skip(16000);
  ctx.server.mmo.sweep();
  await sleep(50);
  assert.equal(late.closed, false, 'its pongs kept it');
});
