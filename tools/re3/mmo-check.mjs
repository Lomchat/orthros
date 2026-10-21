// Multi-client check of an re3 port's shared world (docs/mmo.md, section 8): one Chromium, two browser contexts (up to
// four: --players) — two devices, each signed in to its own Orthros account (the QA accounts of /tmp/orthros-scratch/qa-accounts.json, shared
// with tools/re3/check.mjs and tools/goldsrc/check.mjs; made through the account API when missing) — each on the
// version's play page with ?mmotest, small windows. The engine then reads one test command a frame
// (window.orthrosMmo.command) and publishes its state every 500 ms (window.orthrosMmo.state: mode, link, slot, admin,
// inWorld, pos, health, money, wanted, weapon, vehicle, players, owned, puppets, chat…); every step here is a command,
// every check a wait on those states, every wait bounded (and the whole run by --seconds).
//
// Scenarios (--scenario, a comma list or all; every player joins first, whatever the scenario but freemode; the
// two-player scenarios use A and B, the others idle in the world):
//   basic       each sees the other at its place (2 m), away from the page shown to the other, leave + join again keeps
//               the money and the place, a dropped connection comes back (the engine joins again) — a server restart's
//               effect on the page
//   chat        a line each way, seen by both
//   combat      shots from A hurt B, B dies, respawns ($100 less, no weapon, elsewhere), A sees B there
//   population  ambient peds and cars around both: owned by one, copies on the other; B leaves: A's copies become its own
//   world       cheats: refused for a non-admin, an admin's wanted level shown to the other (stars), world cheats on both
//               (when the engine publishes `weather`), the teleport list
//   garage      a car stored in a hideout by A, found there by B
//   away        an away player hurt like anyone: B in its pause menu hurt by A's shots and killed there (the kill line
//               on A at once), then B's tab hidden (its engine frozen: rAF held, document.hidden, visibilitychange) while
//               A shoots it: the hits, older than the old 20 s limit, applied when B shows again — B dies of them
//   aim         the mouse aim, a real click (Playwright's mouse on the canvas): the crosshair's line kept on B's copy
//               ("look"), A's M4, shotgun and baseball bat hurt B
//   stars       the wanted level as in the game: a local cop shot by A alone (B far) gives stars, kept when it dies;
//               a cop of B's (a copy on A) shot by A: hurt at B, A's stars, seen over A by B; a civilian of B's killed
//               by A: A's crime counted (chaos)
// Run only when named (--scenario crowd,perks or all,crowd…):
//   crowd       --players 3 or 4 (one more device each, every one an administrator of the test server with --admins):
//               every player lists and sees every other at one place (2 m, its copy with its name), every line seen by
//               all, an admin's wanted stars seen by all, the shared entities audited (each network id owned by one
//               client, a copy on the others near it, no copy of an id nobody owns), A kills B while the others watch
//               (the kill line on all, B back with 200 health, $100 less, no weapon), the last player leaves (dropped by
//               all, its entities taken over) and comes back (its money and place), a world cheat on all, a car stored
//               in a hideout by C known by all
//   perks       every character: 200 health at most and the infinite sprint; a new character (made, checked, deleted):
//               200 health, $5000 and a pistol at the hotel, a sprint that does not tire
//   freemode    alone, one page and no shared world: the menu's free mode (ArrowDown, Enter, Enter as check.mjs --keys),
//               "teleport" typed (the cheats' reader), a place chosen with the arrows and Enter, the player moved there
// Results: one CHECK line (JSON) per check, RESULTS (JSON) at the end; exit 0 when every check passed. On a failed check
// both pages are photographed, with their last states and logs, under /tmp/orthros-scratch/mmo-check/<run>/.
//
// Start it through the browser slot guard (CLAUDE.md, "Shared server budget"):
//   tools/with-browser-slot.sh node tools/re3/mmo-check.mjs [vice-city-orthros] --url http://127.0.0.1:8080
//     [--seconds 900] [--scenario basic|chat|combat|population|world|garage|crowd|perks|freemode|all] [--players 2..4]
//     [--admins <test server's admins.json>]
//     [--lang en] [--skin <model>] [--weapon 26] [--car 130] [--exit-key f] [--width 480 --height 300]
// --admins: every player made an admin of the test server (its <mmo dir>/admins.json, re-read by the server) before
// it joins; never the live server's. Without it, the admin checks are skipped. A QA account the test server does not
// know (its accounts made anew) is replaced by a new one.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SCENARIOS = Object.freeze(['basic', 'chat', 'combat', 'combatx', 'combatp', 'combatv', 'away', 'aim', 'stars', 'population', 'world', 'garage']);
/** Scenarios run only when named (not in `all`): crowd (3 players or more), perks (a new character), freemode (alone). */
export const NAMED_SCENARIOS = Object.freeze(['crowd', 'perks', 'freemode']);
export const MAX_PLAYERS = 4;
/** The players' tags, in their order (the first one the most senior). */
export const TAGS = Object.freeze(['A', 'B', 'C', 'D']);
export const OUT_ROOT = process.env.MMO_CHECK_OUT || '/tmp/orthros-scratch/mmo-check';
// (a death to its respawn is ~8 s of the game's time, which advances at most ~60 ms a frame: at the test machine's 0.1–0.5
// frame a second, up to 10 minutes or more)
const RESPAWN_MS = 900000;
/** Places of Vice City the scenarios use (a test tool's knowledge of the game it checks — never the runtime's). */
export const PLACES = Object.freeze({
  hotel: [233.5, -1278.45, 11.0],     // the Ocean View hotel's door, Ocean Drive (new characters start here)
  far: [-834.8, 1306.9, 11.0],        // Downtown, about 2.9 km away
  garageOut: [446.0, 638.4, 11.6],    // in front of the Vice Point hideout's door (hideout 0)
  garageIn: [454.06, 638.38, 11.6],   // inside it
});

/** The command line: { manifest, url, seconds, scenarios, admins, lang, skin, weapon, car, exitKey, width, height }. */
export function parseArgs(argv) {
  const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && VALUED.has(argv[i - 1].slice(2))));
  const num = (k, d, min, max) => {
    const v = Number(opt(k, d));
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`--${k}: a number from ${min} to ${max}`);
    return v;
  };
  const scenarios = scenarioList(opt('scenario', 'all'));
  const freemode = scenarios.includes('freemode');
  if (freemode && scenarios.length > 1) throw new Error('--scenario freemode: alone (one page, no shared world)');
  const players = num('players', freemode ? 1 : 2, freemode ? 1 : 2, MAX_PLAYERS);
  if (scenarios.includes('crowd') && players < 3) throw new Error('--scenario crowd: --players 3 or more');
  return {
    manifest: positional[0] ?? 'vice-city-orthros',
    url: String(opt('url', 'http://127.0.0.1:8080')).replace(/\/+$/, ''),
    seconds: num('seconds', 900, 30, 7200),
    scenarios,
    players,
    admins: opt('admins', null),
    lang: opt('lang', 'en'),
    skin: opt('skin', null),
    weapon: num('weapon', 26, 1, 255),
    car: num('car', 130, 1, 65535),
    exitKey: opt('exit-key', 'f'),
    width: num('width', 480, 320, 3840),
    height: num('height', 300, 240, 2160),
  };
}
const VALUED = new Set(['url', 'seconds', 'scenario', 'players', 'admins', 'lang', 'skin', 'weapon', 'car', 'exit-key', 'width', 'height']);
/** 'all' (the two-player scenarios, then any named one), one scenario or a comma list → the scenarios in their order. */
export function scenarioList(text) {
  const wanted = String(text).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const known = [...SCENARIOS, ...NAMED_SCENARIOS];
  for (const s of wanted) if (s !== 'all' && !known.includes(s)) throw new Error(`unknown scenario ${s} (${known.join(', ')}, all)`);
  if (!wanted.length || wanted.includes('all')) return [...SCENARIOS, ...NAMED_SCENARIOS.filter((s) => wanted.includes(s))];
  return known.filter((s) => wanted.includes(s));
}
/** A position as [x, y, z]: from [x, y, z] or { x, y, z }; null when none. */
export function vec(p) {
  if (Array.isArray(p) && p.length >= 3 && p.slice(0, 3).every(Number.isFinite)) return p.slice(0, 3).map(Number);
  if (p && typeof p === 'object' && [p.x, p.y, p.z].every(Number.isFinite)) return [p.x, p.y, p.z];
  return null;
}
export function distance(a, b) {
  const p = vec(a), q = vec(b);
  return p && q ? Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) : Infinity;
}
export const offset = (p, dx = 0, dy = 0, dz = 0) => { const v = vec(p); return [v[0] + dx, v[1] + dy, v[2] + dz]; };
export const tpCommand = (p) => `tp ${vec(p).map((v) => v.toFixed(2)).join(' ')}`;
/**
 * A character's name for an account: the server's rule (2–16 of A-Z a-z 0-9 and single separators — space _ . - —
 * between them, a letter or digit first and last).
 */
export function characterName(username) {
  const trim = (x) => x.replace(/^[ _.-]+|[ _.-]+$/g, '');
  let n = trim(String(username).replace(/[^A-Za-z0-9 _.-]/g, '').replace(/([ _.-])[ _.-]+/g, '$1')).slice(0, 16);
  n = trim(n);
  if (n.length < 2) n = ('qa' + n).slice(0, 16);
  return n;
}
/** `state`'s entry for the remote player named `name` (case-insensitive), or null. */
export function playerIn(state, name) {
  const want = String(name).toLowerCase();
  return (Array.isArray(state?.players) ? state.players : []).find((p) => String(p?.name ?? '').toLowerCase() === want) ?? null;
}
/** Whether `observer` sees `target` (whose own state is given) within `meters` of where `target` is. */
export function seesAt(observer, target, targetName, meters = 2) {
  const entry = playerIn(observer, targetName), d = entry ? distance(entry.pos, target?.pos) : Infinity;
  return { ok: d <= meters, dist: Number.isFinite(d) ? Math.round(d * 100) / 100 : null, seen: !!entry };
}
/** Whether a chat line holds `text` (lines as strings or objects). */
export function chatHas(state, text) {
  return (Array.isArray(state?.chat) ? state.chat : []).some((line) => (typeof line === 'string' ? line : JSON.stringify(line)).includes(text));
}
const n = (v) => (Number.isFinite(v) ? v : Number.isFinite(v?.count) ? v.count : Array.isArray(v) ? v.length : 0);
/** The ambient entities a state tells of. */
export function census(state) {
  const ownedPeds = n(state?.owned?.peds), ownedVehicles = n(state?.owned?.vehicles), puppetPeds = n(state?.puppets?.peds), puppetVehicles = n(state?.puppets?.vehicles);
  return { ownedPeds, ownedVehicles, puppetPeds, puppetVehicles, owned: ownedPeds + ownedVehicles, puppets: puppetPeds + puppetVehicles };
}
/** The network ids a state lists (an engine may publish them: netids, or ids under owned / puppets), else null. */
export function netids(state, which = 'all') {
  const pick = (o) => (Array.isArray(o?.ids) ? o.ids : []);
  const ids = which === 'owned' ? pick(state?.owned) : which === 'puppets' ? pick(state?.puppets) : [...(Array.isArray(state?.netids) ? state.netids : []), ...pick(state?.owned), ...pick(state?.puppets)];
  return ids.length ? new Set(ids.map(Number)) : null;
}
export const unarmed = (state) => state?.weapon == null || state.weapon === 0 || state.weapon === 'unarmed' || (Array.isArray(state.weapon) && !state.weapon.length) || state.weapon?.id === 0;
export const dead = (state) => (Number.isFinite(state?.health) && state.health <= 0) || /dead|wasted|die/i.test(String(state?.mode ?? '')) || state?.dead === true;
/** The respawn's checks: the hospital's $100, the weapons gone, alive, elsewhere than the death. */
export function respawnChecks(beforeDeath, deathPos, after) {
  const fee = Math.max(0, (beforeDeath?.money ?? 0) - 100);
  return [
    { name: 'respawn: $100 paid', ok: after?.money === fee, detail: { before: beforeDeath?.money, after: after?.money, expected: fee } },
    { name: 'respawn: weapons lost', ok: unarmed(after), detail: { weapon: after?.weapon ?? null } },
    { name: 'respawn: alive', ok: Number.isFinite(after?.health) && after.health > 0, detail: { health: after?.health ?? null } },
    { name: 'respawn: at another place (the hospital)', ok: distance(deathPos, after?.pos) > 5, detail: { death: vec(deathPos), now: vec(after?.pos) } },
  ];
}
/** The shared world's forced weather as the engine publishes it (world.weather.var; a top-level weather else). */
export const weatherOf = (state) => state?.world?.weather?.var ?? state?.weather ?? null;
/** An admins file this check may change: never the live server's state. */
export function adminsPathAllowed(file) {
  const abs = path.resolve(file);
  return !(abs.startsWith('/var/lib/') || abs.startsWith('/srv/orthros/') || abs === '/srv/orthros');
}
/** `username` added to an admins list (lowercase, once). */
export function withAdmin(list, username) {
  const names = Array.isArray(list) ? list.map((x) => String(x).toLowerCase()) : [];
  const u = String(username).toLowerCase();
  return names.includes(u) ? names : [...names, u];
}
/** The run's outcome from its checks: { passed, failed, skipped, scenarios: { name: { ok, checks } } }. */
export function summarize(checks) {
  const scenarios = {};
  for (const c of checks) {
    const s = scenarios[c.scenario] ??= { ok: true, passed: 0, failed: 0, skipped: 0 };
    if (c.skipped) s.skipped++; else if (c.ok) s.passed++; else { s.failed++; s.ok = false; }
  }
  const failed = checks.filter((c) => !c.ok && !c.skipped).length;
  return { passed: failed === 0 && checks.some((c) => c.ok), failed, checks: checks.length, skipped: checks.filter((c) => c.skipped).length, scenarios };
}

/** The engine's id lists stop at this many (mmo_entities.cpp MAX_IDS): a full list may leave ids out. */
export const MAX_LISTED_IDS = 96;
/**
 * The shared entities' network ids across the players' states at one moment ([{ tag, slot, state }]): each id owned by
 * one client exactly, copies of it on the others near it, no copy of an id nobody owns.
 *   owners      { id: [tags owning it] }
 *   duplicates  ids owned by two clients or more
 *   ghosts      [{ tag, id, owner }]: a copy whose id no client owns (judged only when every owned list is complete)
 *   wrongOwner  [{ tag, id, owner, actual }]: a copy that names another owner than the one that has it
 *   coverage    { expected, present, missing: [{ tag, id, owner }] }: entities owned by one, within `radius` of
 *               another player, a copy there
 */
export function entityAudit(entries, radius = 50) {
  const ids = (o) => (Array.isArray(o?.ids) ? o.ids.map(Number) : []);
  const near = (s) => (Array.isArray(s?.near) ? s.near : []);
  const owners = {}, ownedBy = new Map(), puppetsOf = new Map(), complete = entries.every((e) => ids(e.state?.owned).length < MAX_LISTED_IDS);
  for (const { tag, state } of entries) {
    const mine = new Set(ids(state?.owned));
    for (const e of near(state)) if (e && e.copy === false) mine.add(Number(e.id));
    ownedBy.set(tag, mine);
    const copies = new Map(ids(state?.puppets).map((id) => [id, null]));
    for (const e of near(state)) if (e && e.copy === true) copies.set(Number(e.id), Number.isFinite(e.o) ? e.o : null);
    puppetsOf.set(tag, copies);
    for (const id of mine) (owners[id] ??= []).push(tag);
  }
  const duplicates = Object.keys(owners).filter((id) => owners[id].length > 1).map(Number);
  const bySlot = new Map(entries.map((e) => [e.slot, e.tag]));
  const ghosts = [], wrongOwner = [];
  for (const { tag } of entries)
    for (const [id, owner] of puppetsOf.get(tag)) {
      const actual = owners[id] ?? [];
      if (!actual.length) { if (complete) ghosts.push({ tag, id, owner }); continue; }
      if (owner != null && bySlot.has(owner) && !actual.includes(bySlot.get(owner))) wrongOwner.push({ tag, id, owner, actual });
    }
  const coverage = { expected: 0, present: 0, missing: [] };
  for (const { tag: ownerTag, state } of entries)
    for (const e of near(state)) {
      if (!e || e.copy !== false || !vec(e.p)) continue;
      for (const other of entries) {
        if (other.tag === ownerTag || distance(e.p, other.state?.pos) > radius || ownedBy.get(other.tag).has(Number(e.id))) continue; // (owned twice: a duplicate)
        coverage.expected++;
        if (puppetsOf.get(other.tag).has(Number(e.id))) coverage.present++;
        else coverage.missing.push({ tag: other.tag, id: Number(e.id), owner: ownerTag });
      }
    }
  return { owners, duplicates, ghosts, wrongOwner, coverage, complete };
}
/** What stays wrong in every one of several audits (a moment's handover is no fault): ids found in all of them. */
export function persistentFaults(audits) {
  if (!audits.length) return { duplicates: [], ghosts: [], wrongOwner: [] };
  const keyed = (list, key) => new Set(list.map(key));
  const inAll = (pick, key) => {
    const sets = audits.map((a) => keyed(pick(a), key));
    return pick(audits[audits.length - 1]).filter((x) => sets.every((s) => s.has(key(x))));
  };
  return {
    duplicates: inAll((a) => a.duplicates, (x) => String(x)),
    ghosts: inAll((a) => a.ghosts, (x) => `${x.tag}:${x.id}`),
    wrongOwner: inAll((a) => a.wrongOwner, (x) => `${x.tag}:${x.id}`),
  };
}
/** Places `count` players `apart` meters from one another around `place` (a line east-west, then north). */
export function gathering(place, count, apart = 3) {
  return Array.from({ length: count }, (_, i) => offset(place, (i % 2) * apart, Math.floor(i / 2) * apart));
}
/** The kill line of a death ("<killer> killed <victim>" / "<killer> a tué <victim>") among a state's chat lines. */
export function killLine(state, victim, killer = null) {
  return (Array.isArray(state?.chat) ? state.chat : []).find((l) => {
    const t = typeof l === 'string' ? l : JSON.stringify(l);
    return /killed|a tu/.test(t) && t.includes(victim) && (!killer || t.includes(killer));
  }) ?? null;
}

// ---------------------------------------------------------------- the run (a browser: never on import)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function main() {
  const o = parseArgs(process.argv.slice(2));
  const started = Date.now(), deadline = started + o.seconds * 1000;
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(OUT_ROOT, runId);
  fs.mkdirSync(out, { recursive: true }); process.env.TMPDIR = out;
  const left = () => deadline - Date.now();
  const checks = [];
  let shots = 0;
  const clients = [];
  /** one check: printed, kept, both pages photographed when it failed */
  async function check(scenario, name, ok, detail = {}, { skipped = false } = {}) {
    const c = { scenario, name, ok: !!ok, skipped, detail, at: Math.round((Date.now() - started) / 1000) };
    checks.push(c); console.log('CHECK', JSON.stringify(c));
    if (!ok && !skipped) await evidence(`${scenario}-${name}`);
    return !!ok;
  }
  const skip = (scenario, name, why) => check(scenario, name, true, { why }, { skipped: true });
  async function evidence(label) {
    if (shots >= 12) return;
    const slug = label.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60);
    for (const c of clients) {
      if (!c.page) continue;
      shots++;
      await c.page.screenshot({ path: path.join(out, `${String(shots).padStart(2, '0')}-${slug}-${c.tag}.png`), timeout: 20000 }).catch(() => {});
      const ev = await c.page.evaluate(() => ({ mmo: window.orthrosMmo ? { state: window.orthrosMmo.state, link: window.orthrosMmo.link.stats() } : null, session: window.portSession?.state, logs: window.portSession?.logs?.slice(-120) })).catch((e) => ({ error: e.message }));
      fs.writeFileSync(path.join(out, `${String(shots).padStart(2, '0')}-${slug}-${c.tag}.json`), JSON.stringify(ev, null, 1));
    }
  }

  // ---- the server: the version, its world
  const manifests = await (await fetch(`${o.url}/api/manifests`)).json();
  const listed = manifests.find((m) => m.name === o.manifest);
  if (!listed?.available) throw new Error(`${o.manifest} is not available on ${o.url}: ${JSON.stringify(listed ?? null)}`);
  if (!listed.mmo) throw new Error(`${o.manifest} has no shared world (its version has no "mmo")`);
  const pageUrl = `${o.url}${listed.launchUrl}?mmotest&gameLang=${encodeURIComponent(o.lang)}`;
  console.log('HOME', JSON.stringify({ title: listed.title, version: listed.version, pageUrl }));

  // ---- the accounts (the QA ones, made when missing)
  const qaFile = '/tmp/orthros-scratch/qa-accounts.json';
  let qa = []; try { qa = JSON.parse(fs.readFileSync(qaFile, 'utf8'))[o.url] ?? []; } catch { /* none yet */ }
  async function signIn(context, i) {
    const page = await context.newPage(); await page.goto(`${o.url}/?menu`, { timeout: 60000 });
    const fresh = () => ({ username: `qa-check-${i + 1}-${Math.random().toString(36).slice(2, 7)}`, password: Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('') });
    const call = (a, create) => page.evaluate(async ({ a, create }) => {
      const r = await fetch(create ? '/api/account/register' : '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: a.username, password: a.password }) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, { a, create });
    let account = qa[i] ?? fresh(), created = !qa[i];
    let result = await call(account, created);
    // (a test server's accounts made anew — its accounts directory emptied —: the QA account made again there)
    if (result.status !== 200 && !created && result.status !== 429) { console.log('QA ACCOUNT', account.username, 'unknown here:', result.status, '— a new one'); account = fresh(); created = true; result = await call(account, true); }
    if (result.status !== 200) throw new Error(`QA account ${account.username}: ${result.status} ${JSON.stringify(result.body)}`);
    if (created) { qa[i] = account; let all = {}; try { all = JSON.parse(fs.readFileSync(qaFile, 'utf8')); } catch { /* new */ } all[o.url] = qa; fs.writeFileSync(qaFile, JSON.stringify(all, null, 1), { mode: 0o600 }); }
    const world = await page.evaluate((id) => fetch(`/api/mmo/${encodeURIComponent(id)}`, { cache: 'no-store' }).then((r) => r.json()).catch((e) => ({ error: e.message })), o.manifest);
    await page.close();
    return { username: result.body?.user?.username ?? account.username, world };
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', ...(process.env.MMO_CDP_PORT ? [`--remote-debugging-port=${process.env.MMO_CDP_PORT}`] : []), ...(process.env.MMO_JS_FLAGS ? [`--js-flags=${process.env.MMO_JS_FLAGS}`] : [])] });
  const heartbeat = setInterval(async () => {
    const line = [];
    for (const c of clients) line.push(await c.read().then((s) => ({ c: c.tag, mode: s?.mode, link: s?._page?.link, inWorld: s?.inWorld, fps: s?.fps, updates: s?._page?.updates })).catch(() => ({ c: c.tag, closed: true })));
    console.log('PROGRESS', Math.round((Date.now() - started) / 1000), JSON.stringify(line));
  }, 15000);
  try {
    // ---- one device per player (two by default; --players up to four)
    for (const [i, tag] of TAGS.slice(0, o.players).entries()) {
      const context = await browser.newContext({ viewport: { width: o.width, height: o.height } });
      const who = await signIn(context, i);
      const c = { tag, context, page: null, username: who.username, name: characterName(who.username), world: who.world };
      c.read = async () => c.page.evaluate(() => {
        const m = window.orthrosMmo; if (!m) return null;
        return { ...(m.state ?? {}), _page: { link: m.link.state(), refusal: m.link.refusal(), joined: m.link.joined(), updates: m.updates, stats: m.link.stats() } };
      });
      c.cmd = async (text) => { console.log('COMMAND', tag, text); await c.page.evaluate((t) => window.orthrosMmo.command(t), text); };
      c.pageCall = (fn, arg) => c.page.evaluate(fn, arg);
      clients.push(c);
    }
    const [A, B] = clients;
    console.log('PLAYERS', JSON.stringify(clients.map((c) => ({ tag: c.tag, username: c.username, name: c.name, world: c.world }))));
    if (!A.world?.enabled && !o.scenarios.includes('freemode')) throw new Error(`the server's world for ${o.manifest} is not enabled: ${JSON.stringify(A.world)}`);
    if (o.admins) {
      if (!adminsPathAllowed(o.admins)) throw new Error(`--admins ${o.admins}: not the live server's state — give the test server's <mmo dir>/admins.json`);
      let list = []; try { list = JSON.parse(fs.readFileSync(o.admins, 'utf8')); } catch { /* new */ }
      fs.mkdirSync(path.dirname(path.resolve(o.admins)), { recursive: true });
      // (every player: in a shared world the test commands that set a player's state — money, tp, weapon, car — are an
      // administrator's only, like the cheats; the world scenario takes B's rights away for its non-admin checks)
      for (const c of clients) list = withAdmin(list, c.username);
      fs.writeFileSync(o.admins, JSON.stringify(list) + '\n');
      console.log('ADMIN', clients.map((c) => c.username).join(' '), 'in', o.admins);
    }

    /** waits until `predicate(state)` holds (polled every 500 ms), at most `ms` and never past the run's budget */
    async function until(c, ms, predicate) {
      const end = Math.min(Date.now() + ms, deadline);
      let state = null;
      for (;;) {
        state = await c.read().catch(() => null);
        let value = false; try { value = predicate(state); } catch { value = false; }
        if (value) return { ok: true, state, value };
        if (Date.now() >= end) return { ok: false, state, timedOut: true, budget: Date.now() >= deadline };
        await sleep(500);
      }
    }
    /** both states, read at once */
    const both = async () => Promise.all([A.read(), B.read()]);
    /** waits until `predicate(stateA, stateB)` holds, as until() */
    async function untilBoth(ms, predicate) {
      const end = Math.min(Date.now() + ms, deadline);
      for (;;) {
        const [a, b] = await both().catch(() => [null, null]);
        let value = false; try { value = predicate(a, b); } catch { value = false; }
        if (value || Date.now() >= end) return { ok: !!value, a, b };
        await sleep(500);
      }
    }

    /** every player's state, read at once (the clients' order) */
    const everyone = async (list = clients) => Promise.all(list.map((c) => c.read().catch(() => null)));
    /** waits until `predicate(states)` holds for the players of `list`, as until() */
    async function untilAll(ms, predicate, list = clients) {
      const end = Math.min(Date.now() + ms, deadline);
      for (;;) {
        const states = await everyone(list);
        let value = false; try { value = predicate(states); } catch { value = false; }
        if (value || Date.now() >= end) return { ok: !!value, states };
        await sleep(500);
      }
    }
    /** for every ordered pair (observer, target) of `list`: whether the observer sees the target within 2 m, a copy */
    const pairs = (list) => list.flatMap((x) => list.filter((y) => y !== x).map((y) => [x, y]));
    function crowdSight(list, states) {
      const at = new Map(list.map((c, i) => [c, states[i]]));
      return pairs(list).map(([x, y]) => {
        const s = seesAt(at.get(x), at.get(y), y.name), entry = playerIn(at.get(x), y.name);
        return { seer: x.tag, seen: y.tag, ...s, puppet: entry?.puppet ?? null, ok: s.ok && entry?.puppet === true };
      });
    }

    // ---- the pages: the engine at its main menu, publishing its state
    for (const c of clients) {
      c.page = await c.context.newPage();
      c.page.setDefaultTimeout(120000);
      c.page.on('pageerror', (error) => console.log('PAGE ERROR', c.tag, error.message));
      c.page.on('crash', () => console.log('CRASH', c.tag));
      await c.page.goto(pageUrl, { timeout: 120000 });
      await c.page.waitForFunction(() => ['running', 'error'].includes(window.portSession?.state), null, { timeout: Math.max(1000, Math.min(300000, left())) });
      const st = await c.page.evaluate(() => ({ state: portSession.state, status: document.querySelector('#status')?.textContent }));
      if (st.state !== 'running') throw new Error(`${c.tag}: the game did not start: ${st.status}`);
      if (!(await c.page.evaluate(() => !!window.orthrosMmo))) throw new Error(`${c.tag}: the page made no shared world link (its version's mmo?)`);
    }
    for (const c of clients) {
      const r = await until(c, 240000, (s) => s?._page?.updates > 0);
      if (!await check('setup', `${c.tag}: the engine publishes its state (?mmotest)`, r.ok, { mode: r.state?.mode })) throw new Error('no engine state: an engine without the shared world, or ?mmotest ignored');
    }

    // ---- both join (A first: the more senior)
    async function join(c) {
      for (let attempt = 0; attempt < 3; attempt++) {
        await c.cmd(`join ${c.name}${o.skin ? ` ${o.skin}` : ''}`);
        const r = await until(c, attempt ? 240000 : 300000, (s) => s?.inWorld === true || (s?._page?.link === 3));
        if (r.state?._page?.link === 3) return { ok: false, state: r.state, refused: r.state._page.refusal };
        if (r.ok) return r;
        if (r.budget) return r;
      }
      return { ok: false };
    }
    const freeOnly = o.scenarios.includes('freemode'); // (the free mode: no shared world joined)
    for (const c of freeOnly ? [] : clients) {
      const r = await join(c);
      c.slot = r.state?.slot;
      if (!await check('setup', `${c.tag} joins the world as ${c.name}`, r.ok, { slot: r.state?.slot, admin: r.state?.admin, refused: r.refused ?? null, mode: r.state?.mode })) throw new Error(`${c.tag} could not join`);
      c.admin = !!r.state?.admin;
    }
    if (!freeOnly) {
      const states = await Promise.all(clients.map((c) => c.read()));
      const slots = states.map((s) => s?.slot);
      await check('setup', 'the players have their own slots', slots.every(Number.isFinite) && new Set(slots).size === slots.length, Object.fromEntries(clients.map((c, i) => [c.tag, slots[i]])));
      clients.forEach((c, i) => { c.slot = slots[i]; });
    }
    /** both at `place` (B a few meters east), each seeing the other there */
    async function together(scenario, place, apart = 3) {
      await A.cmd(tpCommand(place)); await B.cmd(tpCommand(offset(place, apart)));
      const r = await until(A, 60000, (s) => distance(s?.pos, place) < 3);
      const rb = await until(B, 60000, (s) => distance(s?.pos, offset(place, apart)) < 3);
      if (!r.ok || !rb.ok) { await check(scenario, 'both teleported together', false, { A: vec(r.state?.pos), B: vec(rb.state?.pos), place }); return false; }
      const seen = await untilBoth(30000, (a, b) => seesAt(a, b, B.name).ok && seesAt(b, a, A.name).ok);
      return check(scenario, 'each sees the other where it is (2 m)', seen.ok, { AseesB: seesAt(seen.a, seen.b, B.name), BseesA: seesAt(seen.b, seen.a, A.name) });
    }

    /** both alive (a respawn waited for) and healed (the health cheat: both are administrators of the test server) */
    async function healed() {
      for (const c of clients) {
        await until(c, RESPAWN_MS, (s) => !dead(s) && Number.isFinite(s?.health) && s.health > 0 && s?.inWorld !== false);
        await c.cmd('cheat ASPIRINE');
      }
      await untilBoth(20000, (a, b) => a?.health >= 99 && b?.health >= 99);
    }
    /**
     * The tab hidden (on) or shown again, as a browser does it: document.hidden and visibilitychange (the page tells the
     * world it is away) and the engine frozen — its frames wait for requestAnimationFrame, held meanwhile — while the
     * page's own tasks (the link, its queue) go on.
     */
    async function hideTab(c, on) {
      await c.pageCall((hide) => {
        if (!window.__mmoHide) {
          const raf = window.requestAnimationFrame.bind(window), held = [];
          const proto = (k) => Object.getOwnPropertyDescriptor(Document.prototype, k);
          const hidden = proto('hidden'), state = proto('visibilityState');
          const h = window.__mmoHide = { on: false, held, release: () => { for (const cb of held.splice(0)) raf(cb); } };
          window.requestAnimationFrame = (cb) => { if (h.on) { held.push(cb); return 0; } return raf(cb); };
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => h.on || hidden.get.call(document) });
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h.on ? 'hidden' : state.get.call(document)) });
        }
        window.__mmoHide.on = hide;
        document.dispatchEvent(new Event('visibilitychange'));
        if (!hide) window.__mmoHide.release();
      }, on);
    }
    /** the mouse on the middle of a page's canvas (where the game's own pointer stays) */
    async function mouseHome(c) {
      const box = await c.page.locator('#canvas').boundingBox();
      c.mouseAt = [box.x + box.width / 2, box.y + box.height / 2];
      await c.page.mouse.move(...c.mouseAt);
    }
    /** a real click of the mouse's left button on the canvas, held until the player's weapon fired (or `ms`) */
    async function click(c, ms = 30000) {
      if (!c.mouseAt) await mouseHome(c);
      const f0 = (await c.read())?.combat?.playerFires ?? 0;
      await c.page.mouse.down();
      const r = await until(c, ms, (s) => (s?.combat?.playerFires ?? 0) > f0);
      await c.page.mouse.up();
      return r;
    }
    /** the crosshair kept on a target ("look": <slot>, e<netid>, spawned), until its line meets it within `deg` */
    async function lookAt(c, target, deg = 2.5) {
      if (!c.mouseAt) await mouseHome(c);
      await c.cmd(`look ${target} 90`);
      return until(c, 60000, (s) => s?.combat?.look?.active === true && s.combat.look.err >= 0 && s.combat.look.err < deg);
    }
    /** clicks (each held until the weapon fired) until `done(state of watched)` or `max` clicks */
    async function clickUntil(c, watched, done, max = 8, wait = 15000, target = null) {
      let r = { ok: false }, clicks = 0;
      for (; clicks < max && !r.ok && left() > 60000; clicks++) {
        // (a target that moves — a shot cop runs, or comes for the shooter —: the crosshair put on it again first)
        if (target != null && clicks > 0) await lookAt(c, target);
        await click(c);
        r = await until(watched, wait, done);
      }
      return { ...r, clicks };
    }
    /** the player's wanted level cleared (the cheat: an administrator's) */
    async function unwanted(c) {
      await c.cmd('cheat LEAVEMEALONE');
      return until(c, 30000, (s) => (s?.wanted ?? 0) === 0);
    }
    /** shots from `shooter` at `victim` (the "fire" command: one shot each, a lock-on) until done(victim's state) */
    async function shootUntil(shooter, victim, done, max = 60) {
      let shots = 0, state = await victim.read();
      await shooter.cmd(`aim ${victim.slot}`); await sleep(1000);
      for (; shots < max && left() > 60000 && !done(state); shots++) {
        if (shots % 8 === 7) await shooter.cmd(`aim ${victim.slot}`);
        const f0 = (await shooter.read())?.combat?.fires ?? 0;
        await shooter.cmd(`fire ${victim.slot}`);
        await until(shooter, 30000, (s) => (s?.combat?.fires ?? 0) > f0);
        state = await victim.read();
      }
      return { shots, state, ok: done(state) };
    }
    // ---------------------------------------------------------------- the scenarios
    const scenarios = {
      async basic() {
        const r = await until(A, 30000, (s) => !!playerIn(s, B.name));
        const rb = await until(B, 30000, (s) => !!playerIn(s, A.name));
        await check('basic', 'each lists the other', r.ok && rb.ok, { A: (r.state?.players ?? []).map((p) => p.name), B: (rb.state?.players ?? []).map((p) => p.name) });
        await together('basic', PLACES.hotel);
        // (the page's away: the tab hidden)
        await A.pageCall(() => window.orthrosMmo.link.away(true));
        const away = await until(B, 15000, (s) => playerIn(s, A.name)?.away === true || playerIn(s, A.name)?.away === 1);
        await A.pageCall(() => window.orthrosMmo.link.away(false));
        const back = await until(B, 15000, (s) => { const p = playerIn(s, A.name); return p && !p.away; });
        await check('basic', 'the page\'s away shown to the other, then back', away.ok && back.ok, { away: away.ok, back: back.ok });
        // (leave and join again: the money and the place kept by the server)
        const spot = offset(PLACES.hotel, 6), money = 4321;
        await B.cmd(`money ${money}`); await B.cmd(tpCommand(spot));
        const set = await until(B, 30000, (s) => s?.money === money && distance(s?.pos, spot) < 3);
        await check('basic', 'money and place set', set.ok, { money: set.state?.money, pos: vec(set.state?.pos) });
        await sleep(Math.min(12000, Math.max(0, left()))); // (the character saved: every 10 s, and at a money change)
        await B.cmd('leave');
        const out1 = await until(B, 90000, (s) => s?.inWorld === false);
        const gone = await until(A, 30000, (s) => !playerIn(s, B.name));
        await check('basic', 'B leaves: out of the world, gone for A', out1.ok && gone.ok, { mode: out1.state?.mode });
        const again = await join(B);
        await check('basic', 'B joins again', again.ok, { mode: again.state?.mode });
        const kept = await until(B, 30000, (s) => s?.money === money && distance(s?.pos, spot) < 5);
        await check('basic', 'B finds its money and its place again', kept.ok, { money: kept.state?.money, pos: vec(kept.state?.pos), expected: { money, pos: spot } });
        B.slot = kept.state?.slot ?? B.slot;
        // (the connection dropped — as a server restart does: the page reconnects, the engine joins again)
        const connections = (await A.read())?._page?.stats?.connections ?? 0;
        await A.pageCall(() => window.orthrosMmo.link.drop());
        const reopened = await until(A, 60000, (s) => (s?._page?.stats?.connections ?? 0) > connections && s?._page?.link === 2);
        const rejoined = await until(A, 240000, (s) => s?.inWorld === true && s?._page?.joined === true);
        const seenAgain = await until(B, 60000, (s) => !!playerIn(s, A.name));
        await check('basic', 'a dropped connection comes back, A joins again, B sees A', reopened.ok && rejoined.ok && seenAgain.ok,
          { reopened: reopened.ok, rejoined: rejoined.ok, seen: seenAgain.ok, link: rejoined.state?._page?.stats });
        A.slot = rejoined.state?.slot ?? A.slot;
      },
      async chat() {
        const tag = Math.random().toString(36).slice(2, 7);
        for (const [from, to] of [[A, B], [B, A]]) {
          const text = `mmo-check ${from.tag} ${tag}`;
          await from.cmd(`say ${text}`);
          const r = await until(to, 20000, (s) => chatHas(s, text));
          const own = await until(from, 5000, (s) => chatHas(s, text));
          await check('chat', `${from.tag}'s line seen by ${to.tag} and by itself`, r.ok && own.ok, { text, to: r.state?.chat?.slice?.(-3), from: own.state?.chat?.slice?.(-3) });
        }
      },
      async combat() {
        await healed();
        if (!(await together('combat', PLACES.hotel, 4))) return;
        const b = await B.read();
        if (!Number.isFinite(b?.money) || b.money < 200) { await B.cmd('money 1000'); await until(B, 15000, (s) => s?.money === 1000); }
        await A.cmd(`weapon ${o.weapon} 500`);
        const armed = await until(A, 15000, (s) => !unarmed(s));
        await check('combat', 'A armed', armed.ok, { weapon: armed.state?.weapon });
        await A.cmd(`aim ${B.slot}`); await sleep(1000);
        const start = await B.read(), linesBefore = new Set(((await A.read())?.chat ?? []).map((l) => JSON.stringify(l)));
        let hurt = false, killed = false, last = start, beforeDeath = start;
        for (let shot = 0; shot < 120 && left() > 60000 && !killed; shot++) {
          if (shot % 10 === 9) await A.cmd(`aim ${B.slot}`);
          const f0 = (await A.read())?.combat?.fires ?? 0;
          await A.cmd('fire');
          await until(A, 30000, (sa) => (sa?.combat?.fires ?? 0) > f0); // (one shot at a time: commands pile up under 1 fps)
          const s = await B.read();
          if (!dead(s)) beforeDeath = s;
          if (Number.isFinite(s?.health) && s.health < start.health) hurt = true;
          if (dead(s)) killed = true;
          last = s;
        }
        await check('combat', 'A\'s shots hurt B', hurt, { before: start?.health, now: last?.health });
        await check('combat', 'B dies of them', killed, { health: last?.health, mode: last?.mode });
        if (!killed) { await B.cmd('die'); beforeDeath = await B.read(); await until(B, 20000, dead); }
        const deathPos = vec(beforeDeath?.pos) ?? vec(start?.pos);
        // (a death to its respawn is ~8 s of game time; the engine advances at most ~60 ms a frame at the test machine's fps)
        const respawned = await until(B, RESPAWN_MS, (s) => !dead(s) && distance(s?.pos, deathPos) > 5 && s?.inWorld !== false);
        for (const c of respawnChecks(beforeDeath, deathPos, respawned.state)) await check('combat', c.name, c.ok && respawned.ok, c.detail);
        const seen = await untilBoth(30000, (a, bb) => seesAt(a, bb, B.name).ok);
        await check('combat', 'A sees B where B respawned', seen.ok, seesAt(seen.a, seen.b, B.name));
        const feed = await until(A, 10000, (s) => (s?.chat ?? []).some((l) => JSON.stringify(l).includes(B.name) && !linesBefore.has(JSON.stringify(l))));
        await check('combat', 'the kill told in A\'s lines', feed.ok, { chat: feed.state?.chat?.slice?.(-3) });
      },
      async combatx() {
        await healed();
        // (the combat module's own paths: a TARGETED hit without aiming, shots to the death and the kill line, a blast)
        const dump = async (tag) => { const [a, b] = await both(); console.log('COMBAT', tag, JSON.stringify({ A: { h: a?.health, ar: a?.armour, c: a?.combat, chat: a?.chat?.slice?.(-3) }, B: { h: b?.health, ar: b?.armour, c: b?.combat, chat: b?.chat?.slice?.(-3), dead: b?.dead } })); return [a, b]; };
        if (!(await together('combatx', PLACES.hotel, 4))) return;
        let [, b0] = await dump('start');
        await A.cmd(`hit ${B.slot} 30`);
        const hit = await until(B, 30000, (s) => Number.isFinite(s?.health) && s.health < b0.health);
        await check('combatx', 'hit <slot> hurts B (TARGETED, no aim)', hit.ok, { before: b0?.health, now: hit.state?.health, combat: hit.state?.combat });
        await dump('after hit');
        await A.cmd(`weapon ${o.weapon} 500`);
        await until(A, 15000, (s) => s?.weapon === o.weapon);
        await A.cmd(`aim ${B.slot}`); await sleep(1000);
        let killed = false, hurt = false, start = await B.read(), shots = 0;
        for (; shots < 80 && left() > 90000 && !killed; shots++) {
          if (shots % 8 === 7) await A.cmd(`aim ${B.slot}`);
          const f0 = (await A.read())?.combat?.fires ?? 0;
          await A.cmd(shots % 2 ? 'fire' : `fire ${B.slot}`);
          const fr = await until(A, 30000, (sa) => (sa?.combat?.fires ?? 0) > f0);
          const pb = playerIn(fr.state, B.name);
          console.log('FIRE', shots, JSON.stringify({ fires: fr.state?.combat?.fires, fired: fr.state?.combat?.fired, sent: fr.state?.combat?.hitsSent, ev: fr.state?.combat?.eventsSent, w: fr.state?.weapon, ammo: fr.state?.ammo, last: fr.state?.combat?.lastFire, trace: fr.state?.combat?.lastTrace, apos: fr.state?.pos, bpuppet: pb?.pos }));
          await sleep(300);
          const s = await B.read();
          if (Number.isFinite(s?.health) && s.health < start.health) hurt = true;
          if (dead(s)) killed = true;
        }
        await dump('after shots');
        await check('combatx', 'A\'s shots hurt B', hurt, { shots });
        await check('combatx', 'B dies of them', killed, { shots });
        const feedA = await until(A, 30000, (s) => (s?.chat ?? []).some((l) => /killed|a tu/.test(JSON.stringify(l)) && JSON.stringify(l).includes(B.name)));
        const feedB = await until(B, 30000, (s) => (s?.chat ?? []).some((l) => /killed|a tu/.test(JSON.stringify(l)) && JSON.stringify(l).includes(B.name)));
        await check('combatx', 'kill line on both', feedA.ok && feedB.ok, { A: feedA.state?.chat?.slice?.(-3), B: feedB.state?.chat?.slice?.(-3) });
        const respawned = await until(B, RESPAWN_MS, (s) => !dead(s) && s?.health > 0 && s?.inWorld !== false && Number.isFinite(s?.health) && s.health >= 99);
        await check('combatx', 'B respawned', respawned.ok, { health: respawned.state?.health, pos: vec(respawned.state?.pos), money: respawned.state?.money, weapon: respawned.state?.weapon });
        await dump('respawned');
        if (!(await together('combatx', PLACES.hotel, 4))) return;
        await A.cmd(`aim ${B.slot}`); await sleep(1500);
        const b1 = await B.read();
        await A.cmd('explode');
        const blast = await until(B, 30000, (s) => Number.isFinite(s?.health) && s.health < b1.health);
        await check('combatx', 'A\'s blast hurts B (replayed, applied by B)', blast.ok, { before: b1?.health, now: blast.state?.health });
        await dump('after blast');
      },
      async combatp() {
        await healed();
        // (pickups made and taken, a grenade seen and its blast, a flame)
        const dump = async (tag) => { const [a, b] = await both(); console.log('COMBAT', tag, JSON.stringify({ A: { h: a?.health, m: a?.money, seen: a?.combat?.seen, pk: a?.combat?.pickups, pr: a?.combat?.projectiles, ev: a?.combat?.eventsSent }, B: { h: b?.health, m: b?.money, seen: b?.combat?.seen, pk: b?.combat?.pickups, pc: b?.combat?.pickupCopies, pr: b?.combat?.projectiles, dead: b?.dead, blast: b?.combat?.lastBlast, fn: b?.combat?.flameNearest, ign: b?.combat?.ignitions, me: b?.combat?.me, wanted: b?.wanted, pos: b?.pos }, Apos: a?.pos })); return [a, b]; };
        if (!(await together('combatp', PLACES.hotel, 4))) return;
        await dump('start');
        // pickups
        const [a0, b0] = await both();
        await A.cmd('pickup 10');
        const made = await until(B, 120000, (s) => (s?.combat?.seen?.pickupsMade ?? 0) > (b0?.combat?.seen?.pickupsMade ?? 0));
        const [a1, b1] = await dump('pickup made');
        await check('combatp', 'a pickup A dropped is made on B too', made.ok, { A: a1?.combat?.pickups, B: b1?.combat?.pickups });
        if (made.ok) {
          const copy = await until(B, 30000, (s) => (s?.combat?.pickups ?? []).length > 0);
          const spot = (copy.state?.combat?.pickups ?? [])[0] ?? (a1?.combat?.pickups ?? [])[0];
          if (spot) await B.cmd(tpCommand([spot[0], spot[1], spot[2]]));
          const taken = await untilBoth(40000, (a, b) => (a?.combat?.pickups ?? []).length === 0 && (b?.combat?.pickups ?? []).length === 0 &&
            ((a?.money ?? 0) > (a0?.money ?? 0) || (b?.money ?? 0) > (b0?.money ?? 0)));
          await dump('pickup taken');
          await check('combatp', 'taken by one (money), gone for both', taken.ok, { money: { A: [a0?.money, taken.a?.money], B: [b0?.money, taken.b?.money] }, seenTaken: { A: taken.a?.combat?.seen?.pickupsTaken, B: taken.b?.combat?.seen?.pickupsTaken } });
          await B.cmd(tpCommand(offset(PLACES.hotel, 4)));
          await until(B, 30000, (s) => distance(s?.pos, offset(PLACES.hotel, 4)) < 3);
        }
        // a flame (on a player in control, as the game's flames set fire: one knocked down by the blast before gets up
        // first — game seconds, minutes at the test machine's fps)
        await until(B, 300000, (s) => s?.combat?.me?.inControl === true);
        const b3 = await B.read();
        if (!dead(b3)) {
          await A.cmd('weapon 31 500');
          await until(A, 15000, (s) => s?.weapon === 31);
          // (a flame's shot advances by the game's time step: at 0.1–1 frame a second it may leap over the player —
          // up to three bursts)
          let flames = { ok: false }, burnt = { ok: false };
          for (let burst = 0; burst < 3 && !burnt.ok && left() > 120000; burst++) {
            await A.cmd(`aim ${B.slot}`); await sleep(1000);
            for (let i = 0; i < 6; i++) { await A.cmd(`fire ${B.slot}`); await sleep(400); }
            flames = await until(B, 30000, (s) => (s?.combat?.seen?.flames ?? 0) > (b3?.combat?.seen?.flames ?? 0));
            burnt = await until(B, 40000, (s) => Number.isFinite(s?.health) && s.health < b3.health);
            console.log('FLAMES', burst, JSON.stringify({ flames: flames.ok, burnt: burnt.ok, nearest: burnt.state?.combat?.flameNearest, ignitions: burnt.state?.combat?.ignitions }));
          }
          await dump('flame');
          await check('combatp', 'A\'s flames seen by B, B burns', flames.ok && burnt.ok, { flames: flames.ok, health: [b3?.health, burnt.state?.health] });
        } else await skip('combatp', 'A\'s flames seen by B, B burns', 'B dead from the grenade');
        // a grenade
        await A.cmd('weapon 12 10');
        await until(A, 15000, (s) => s?.weapon === 12);
        const [, b2] = await dump('grenade armed');
        await A.cmd(`fire ${B.slot}`);
        const proj = await until(B, 30000, (s) => (s?.combat?.seen?.projectiles ?? 0) > (b2?.combat?.seen?.projectiles ?? 0));
        const blast = await until(B, 120000, (s) => (s?.combat?.seen?.explosions ?? 0) > (b2?.combat?.seen?.explosions ?? 0));
        const hurt = await until(B, 20000, (s) => Number.isFinite(s?.health) && s.health < b2.health);
        await dump('grenade');
        await check('combatp', 'A\'s grenade seen by B, its blast replayed, B hurt', proj.ok && blast.ok && hurt.ok, { proj: proj.ok, blast: blast.ok, hurt: [b2?.health, hurt.state?.health] });
      },
      async combatv() {
        await healed();
        // (vehicles: shots at a remote player's car, a car run into a remote player)
        const dump = async (tag) => { const [a, b] = await both(); console.log('COMBAT', tag, JSON.stringify({ A: { h: a?.health, veh: a?.vehicle, vh: a?.combat?.vehicleHealth, hits: [a?.combat?.hitsSent, a?.combat?.hitsReceived, a?.combat?.hitsApplied, a?.combat?.hitsDropped], last: a?.combat?.lastFire, reg: a?.registry }, B: { h: b?.health, veh: b?.vehicle, vh: b?.combat?.vehicleHealth, hits: [b?.combat?.hitsSent, b?.combat?.hitsReceived, b?.combat?.hitsApplied, b?.combat?.hitsDropped], last: b?.combat?.lastFire, reg: b?.registry, dead: b?.dead } })); return [a, b]; };
        await A.cmd(tpCommand(PLACES.hotel)); await B.cmd(tpCommand(offset(PLACES.hotel, 14)));
        await until(A, 60000, (s) => distance(s?.pos, PLACES.hotel) < 3); await until(B, 60000, (s) => distance(s?.pos, offset(PLACES.hotel, 14)) < 3);
        await A.cmd(`car ${o.car}`);
        const inCar = await until(A, 60000, (s) => !!s?.vehicle);
        if (!await check('combatv', 'A in a car of its own', inCar.ok, { vehicle: inCar.state?.vehicle })) return;
        await sleep(3000);
        let [a0, b0] = await dump('A in car');
        // B shoots A's car
        await B.cmd('weapon 26 500'); await until(B, 15000, (s) => s?.weapon === 26);
        for (let i = 0; i < 4; i++) { const f0 = (await B.read())?.combat?.fires ?? 0; await B.cmd(`fire ${A.slot}`); await until(B, 30000, (s) => (s?.combat?.fires ?? 0) > f0); }
        const shot = await until(A, 30000, (s) => (s?.combat?.hitsApplied ?? 0) > (a0?.combat?.hitsApplied ?? 0));
        [a0, b0] = await dump('B shot A in its car');
        await check('combatv', 'B\'s shots at A in its car applied by A (car or driver)', shot.ok, { vh: [shot.state?.combat?.vehicleHealth], health: shot.state?.health, hits: shot.state?.combat?.hitsApplied });
        // A runs into B (B's copy there first: a special model streamed in frames — minutes at 0.1 frame a second)
        await until(A, 180000, (s) => playerIn(s, B.name)?.puppet === true);
        let rammed = false;
        for (let i = 0; i < 3 && !rammed; i++) {
          const bh = await B.read();
          await A.cmd(`ram ${B.slot} 0.8`); // (a hit that hurts a player in the game: a hard one)
          const r = await until(B, 25000, (s) => (s?.combat?.hitsApplied ?? 0) > (bh?.combat?.hitsApplied ?? 0));
          rammed = r.ok;
          await dump(`ram ${i}`);
        }
        await check('combatv', 'A\'s car hits B (told by the car\'s owner, applied by B)', rammed, {});
        // B's blast next to A's car: A's car blows up (its owner's), B's copy of it is wrecked with it
        const w0 = (await B.read())?.combat?.wrecked ?? 0;
        await B.cmd(`aim ${A.slot}`); await sleep(1500);
        await B.cmd('explode');
        const wreck = await until(B, 120000, (s) => (s?.combat?.wrecked ?? 0) > w0);
        await dump('blast at the car');
        await check('combatv', 'A\'s car blown up there, its copy wrecked on B', wreck.ok, { wrecked: wreck.state?.combat?.wrecked });
      },
      async away() {
        // (an away player is hurt like anyone: in its pause menu, and with its tab hidden — its engine frozen)
        const C = (s) => s?.combat ?? {};
        const respawn = async (label, deathPos) => {
          const r = await until(B, RESPAWN_MS, (s) => !dead(s) && s?.inWorld !== false && Number.isFinite(s?.health) && s.health > 0 && distance(s?.pos, deathPos) > 5);
          await check('away', `B respawned (${label})`, r.ok, { health: r.state?.health, pos: vec(r.state?.pos) });
          return r.ok;
        };
        // (both alive, together and A armed — what a scenario before left — a burning wreck, the police — may kill one
        // meanwhile: tried again)
        const ready = async () => {
          for (let i = 0; i < 3 && left() > 300000; i++) {
            await unwanted(A);
            await healed();
            if (!(await together('away', PLACES.hotel, 4))) continue;
            await A.cmd(`weapon ${o.weapon} 500`);
            const r = await until(A, 15000, (s) => s?.weapon === o.weapon);
            if (r.ok && !dead(r.state) && distance(r.state?.pos, PLACES.hotel) < 3) return true;
          }
          return check('away', 'both ready (alive, together, A armed)', false, {});
        };
        // (the kill lines A shows, counted: the same line twice when A kills B again)
        const kills = (s) => (s?.chat ?? []).filter((l) => /killed|a tu/.test(JSON.stringify(l)) && JSON.stringify(l).includes(B.name)).length;
        if (!(await ready())) return;
        // -- the pause menu
        const b0 = await B.read(), a0 = await A.read(), chaos0 = C(a0).chaos, killsBefore0 = kills(a0);
        await B.cmd('menu');
        const paused = await until(B, 180000, (s) => s?.menuActive === true);
        const shownAway = await until(A, 30000, (s) => playerIn(s, B.name)?.away === true);
        if (!await check('away', 'B in its pause menu, away for A', paused.ok && shownAway.ok, { menuActive: paused.state?.menuActive, away: playerIn(shownAway.state, B.name)?.away })) return;
        let hurt = false;
        const shot = await shootUntil(A, B, (s) => { if (s?.menuActive && Number.isFinite(s?.health) && s.health < b0.health) hurt = true; return dead(s); }, 80);
        const bp = await B.read();
        await check('away', 'B hurt by A\'s shots in its pause menu (applied there)', hurt && C(bp).hitsPaused > (C(b0).hitsPaused ?? 0),
          { shots: shot.shots, health: [b0?.health, bp?.health], hitsPaused: C(bp).hitsPaused, menuActive: bp?.menuActive, applied: C(bp).hitsApplied, dropped: C(bp).hitsDropped });
        await check('away', 'B dies of them, its menu still open', shot.ok && bp?.menuActive === true, { dead: dead(bp), health: bp?.health, menuActive: bp?.menuActive });
        const feed = await until(A, 60000, (s) => kills(s) > killsBefore0 && !!killLine(s, B.name, A.name));
        const stillMenu = await B.read();
        await check('away', 'the kill line on A at once (B still in its menu)', feed.ok && stillMenu?.menuActive === true, { line: killLine(feed.state, B.name), chat: feed.state?.chat?.slice?.(-3), menuActive: stillMenu?.menuActive });
        const aState = await A.read();
        await check('away', 'A\'s shots on a player counted as crimes (A\'s chaos rose)', (C(aState).chaos ?? 0) > (chaos0 ?? 0), { chaos: [chaos0, C(aState).chaos], wanted: aState?.wanted });
        let closed = { ok: false };
        // (one Escape at a time, read by the engine before the next: at 0.2 frame a second a second one sent meanwhile
        // opens the menu again)
        for (let i = 0; i < 4 && !closed.ok; i++) {
          await B.cmd('key ESC');
          closed = await until(B, 180000, (s) => s?.menuActive === false);
          if (closed.ok) { await sleep(10000); closed = await until(B, 1000, (s) => s?.menuActive === false); }
        }
        await check('away', 'B back in the game (its menu closed)', closed.ok, {});
        if (shot.ok) await respawn('pause menu', vec(bp?.pos));
        await unwanted(A);
        // -- the tab hidden
        if (!(await ready())) return;
        // (shots for 60 s at most: at the test machine's 0.1–1 frame a second thirty M4 shots take minutes, past the
        // 120 s a hidden tab's hits are kept)
        await A.cmd(`weapon ${o.weapon} 500`);
        await until(A, 15000, (s) => s?.weapon === o.weapon);
        const h0 = await B.read(), killsBefore = kills(await A.read());
        await hideTab(B, true);
        const hiddenAway = await until(A, 30000, (s) => playerIn(s, B.name)?.away === true);
        await check('away', 'B\'s tab hidden: away for A', hiddenAway.ok, {});
        const sent0 = C(await A.read()).hitsSent ?? 0;
        const firstShot = Date.now();
        let a1 = await A.read(), shots = 0;
        await A.cmd(`aim ${B.slot}`); await sleep(1000);
        // (enough hits to kill — 200 health, the player's share of an M4's 40: 16 — within 60 s)
        for (; shots < 40 && left() > 120000 && Date.now() - firstShot < 60000 && (C(a1).hitsSent ?? 0) - sent0 < 18; shots++) {
          if (shots % 8 === 7) await A.cmd(`aim ${B.slot}`);
          const f0 = C(a1).fires ?? 0;
          await A.cmd(`fire ${B.slot}`);
          a1 = (await until(A, 30000, (s) => (C(s).fires ?? 0) > f0)).state ?? a1;
        }
        const sent = (C(a1).hitsSent ?? 0) - sent0;
        await check('away', 'A\'s shots hit B\'s copy while B is hidden (sent at once, the blood seen there)', sent > 0, { shots, sent, lastFire: C(a1).lastFire });
        // (older than the old 20 s limit when B runs again)
        await sleep(Math.max(0, 25000 - (Date.now() - firstShot)));
        const before = await B.read();
        await hideTab(B, false);
        const applied = await until(B, 180000, (s) => (C(s).hitsApplied ?? 0) > (C(before).hitsApplied ?? 0) && (dead(s) || (Number.isFinite(s?.health) && s.health < h0.health)));
        await check('away', 'B shown again: the hits sent while hidden (over 20 s old) applied', applied.ok,
          { waitedMs: Date.now() - firstShot, health: [h0?.health, applied.state?.health], applied: [C(before).hitsApplied, C(applied.state).hitsApplied], dropped: [C(before).hitsDropped, C(applied.state).hitsDropped] });
        // (a death only when enough hits were sent in the 60 s: 16 of an M4's)
        const died = await until(B, sent >= 16 ? 120000 : 5000, dead);
        if (sent >= 16 || died.ok) {
          await check('away', 'B dies of them', died.ok, { health: died.state?.health, sent });
          const feed2 = await until(A, 60000, (s) => kills(s) > killsBefore);
          await check('away', 'the kill line on A', feed2.ok, { chat: feed2.state?.chat?.slice?.(-3) });
        } else await skip('away', 'B dies of them', `${sent} hits sent in 60 s at this machine's frame rate: not enough to kill`);
        if (died.ok) await respawn('hidden tab', vec(died.state?.pos) ?? vec(h0?.pos));
        await unwanted(A);
      },
      async aim() {
        // (the mouse aim with real clicks: the crosshair's line kept on B's copy, A's M4, shotgun and bat)
        await healed();
        if (!(await together('aim', PLACES.hotel, 5))) return;
        await mouseHome(A);
        for (const [weapon, label, melee] of [[26, 'M4', false], [19, 'shotgun', false], [6, 'baseball bat', true]]) {
          if (left() < 120000) break;
          await healed();
          if (melee) {
            // (B up again — a shotgun knocks down — and still: A at arm's length from it, as A's copy of B shows it)
            const b = (await until(B, 300000, (s) => s?.combat?.me?.inControl === true)).state;
            const spot = offset(b?.pos, -1.2);
            await A.cmd(tpCommand(spot));
            const near = await until(A, 60000, (s) => distance(s?.pos, spot) < 1 && distance(playerIn(s, B.name)?.pos, s?.pos) < 1.6);
            if (!await check('aim', `${label}: A at arm's length from B`, near.ok, { A: vec(near.state?.pos), B: vec(playerIn(near.state, B.name)?.pos) })) continue;
          }
          await A.cmd(`weapon ${weapon} 500`);
          const armed = await until(A, 15000, (s) => s?.weapon === weapon);
          const aimed = await lookAt(A, B.slot, melee ? 25 : 1.5);
          const look = aimed.state?.combat?.look;
          if (!await check('aim', `${label}: the mouse aim's crosshair on B's copy`, armed.ok && aimed.ok && look?.mouse === true, { weapon: aimed.state?.weapon, look })) continue;
          const b0 = await B.read(), hb = b0?.health, applied0 = b0?.combat?.hitsApplied ?? 0;
          const sent0 = (await A.read())?.combat?.hitsSent ?? 0;
          // (A's hit, applied by B: its health down and one more network hit applied there)
          const r = await clickUntil(A, B, (s) => Number.isFinite(s?.health) && s.health < hb && (s?.combat?.hitsApplied ?? 0) > applied0, 6);
          // (A's own state a few frames later: published every 500 ms of its frames)
          const a = (await until(A, 15000, (s) => (s?.combat?.hitsSent ?? 0) > sent0)).state;
          await check('aim', `${label}: a real click hurts B (the player's own weapon path)`, r.ok && (a?.combat?.hitsSent ?? 0) > sent0,
            { clicks: r.clicks, health: [hb, r.state?.health], hitsSent: (a?.combat?.hitsSent ?? 0) - sent0, applied: (r.state?.combat?.hitsApplied ?? 0) - applied0,
              lastSent: a?.combat?.lastSent, received: r.state?.combat?.lastReceived, fires: a?.combat?.playerFires, look: a?.combat?.look });
        }
        await A.cmd('look off');
      },
      async stars() {
        // (the wanted level as in the game: a local cop, a copy of another's, a copy civilian killed)
        const C = (s) => s?.combat ?? {};
        await healed();
        await unwanted(A); await unwanted(B);
        await mouseHome(A);
        await A.cmd('weapon 17 300');
        await until(A, 15000, (s) => s?.weapon === 17);
        // -- a local cop, A alone
        await B.cmd(tpCommand(PLACES.far));
        await until(B, 90000, (s) => distance(s?.pos, PLACES.far) < 5);
        // (A at the hotel's door, the cop 6 m east: open ground, where B stands in the other checks)
        const alone = PLACES.hotel;
        await A.cmd(tpCommand(alone));
        await until(A, 60000, (s) => distance(s?.pos, alone) < 3);
        await sleep(3000);
        await A.cmd('spawn cop 6 0');
        const sp = await until(A, 90000, (s) => C(s).spawned && !C(s).spawned.dead && C(s).spawned.type === 6);
        if (await check('stars', 'a cop made next to A (alone)', sp.ok, { spawned: C(sp.state).spawned ?? null })) {
          const aimed = await lookAt(A, 'spawned');
          const w0 = (await A.read())?.wanted ?? 0, hp = C(sp.state).spawned.health;
          const hit = aimed.ok ? await clickUntil(A, A, (s) => (C(s).spawned?.health ?? hp) < hp, 6) : { ok: false };
          // (a cop shot: two stars at once, the game's EVENT_SHOOT_COP — a shot heard near a cop gives one only)
          const starred = await until(A, 30000, (s) => (s?.wanted ?? 0) >= 2);
          await check('stars', 'a local cop shot by A (alone): A wanted (2 stars)', hit.ok && starred.ok, { aimed: aimed.ok, health: [hp, C(hit.state).spawned?.health], wanted: [w0, starred.state?.wanted], chaos: C(starred.state).chaos });
          await A.cmd('weapon 26 300'); await until(A, 15000, (s) => s?.weapon === 26); // (the kill: an M4's burst — a shot ped runs, the crosshair follows it at the test machine's few frames)
          const killed = await clickUntil(A, A, (s) => C(s).spawned?.dead === true || !C(s).spawned, 20, 15000, 'spawned');
          const kept = await A.read();
          await check('stars', 'the local cop killed: A still wanted', killed.ok && (kept?.wanted ?? 0) >= 1, { clicks: killed.clicks, wanted: kept?.wanted, chaos: C(kept).chaos });
        }
        await A.cmd('look off');
        await unwanted(A);
        // -- a cop of B's: a copy on A
        await healed();
        if (!(await together('stars', PLACES.hotel, 6))) return;
        await A.cmd('weapon 17 300');
        await until(A, 15000, (s) => s?.weapon === 17);
        const copShot = async (kind) => {
          await B.cmd(`spawn ${kind} 5 0`); // (5 m east of B, 11 m east of A: B moves out of the line next)
          const bs = await until(B, 90000, (s) => (C(s).spawned?.id ?? 0) > 0 && !C(s).spawned.dead && C(s).spawned.type === (kind === 'cop' ? 6 : 4));
          const id = C(bs.state).spawned?.id;
          const copy = bs.ok ? await until(A, 90000, (s) => netids(s, 'puppets')?.has(id)) : { ok: false };
          if (!await check('stars', `B's ${kind}: a copy on A`, bs.ok && copy.ok, { spawned: C(bs.state).spawned ?? null })) return null;
          // (B out of the line of fire: its ped stands 5 m ahead of it, B maybe between A and it)
          const aside = offset(bs.state?.pos, 0, 10);
          await B.cmd(tpCommand(aside));
          await until(B, 60000, (s) => distance(s?.pos, aside) < 3);
          const aimed = await lookAt(A, `e${id}`);
          return { id, aimed, hp: C(bs.state).spawned.health };
        };
        const cop = await copShot('cop');
        if (cop) {
          const a0 = await A.read();
          const hit = cop.aimed.ok ? await clickUntil(A, B, (s) => (C(s).spawned?.health ?? cop.hp) < cop.hp, 6) : { ok: false };
          await check('stars', 'A\'s shot at the copy hurts B\'s cop', hit.ok, { aimed: cop.aimed.ok, look: C(cop.aimed.state).look, health: [cop.hp, C(hit.state).spawned?.health] });
          const starred = await until(A, 30000, (s) => (s?.wanted ?? 0) >= 2);
          await check('stars', 'a copy cop shot: A wanted (2 stars)', starred.ok, { wanted: [a0?.wanted, starred.state?.wanted], chaos: [C(a0).chaos, C(starred.state).chaos] });
          const seen = await until(B, 30000, (s) => (playerIn(s, A.name)?.stars ?? 0) >= 2);
          await check('stars', 'A\'s stars seen over A by B', seen.ok, { stars: playerIn(seen.state, A.name)?.stars ?? null });
          await A.cmd('weapon 26 300'); await until(A, 15000, (s) => s?.weapon === 26); // (the kill: an M4's burst — a shot ped runs, the crosshair follows it at the test machine's few frames)
          const killed = await clickUntil(A, B, (s) => C(s).spawned?.dead === true || !C(s).spawned, 20, 15000, `e${cop.id}`);
          const k = await A.read();
          await check('stars', 'B\'s cop killed by A: A still wanted', killed.ok && (k?.wanted ?? 0) >= 1, { clicks: killed.clicks, wanted: k?.wanted, chaos: C(k).chaos });
        }
        await A.cmd('look off');
        await unwanted(A);
        // -- a civilian of B's, killed by A: A's crime counted as the game does (chaos; stars when the police see it)
        // (A free again: the police that came may be arresting or killing it — a respawn then)
        await sleep(Math.min(5000, Math.max(0, left())));
        await until(A, RESPAWN_MS, (s) => !dead(s) && s?.combat?.me?.inControl === true && s?.inWorld !== false);
        await unwanted(A);
        await healed();
        if (!(await together('stars', PLACES.hotel, 6))) return;
        await A.cmd('weapon 17 300');
        await until(A, 15000, (s) => s?.weapon === 17);
        const civ = await copShot('civ');
        if (civ) {
          const a0 = await A.read();
          await A.cmd('weapon 26 300'); await until(A, 15000, (s) => s?.weapon === 26); // (the kill: an M4's burst — a shot ped runs, the crosshair follows it at the test machine's few frames)
          const killed = civ.aimed.ok ? await clickUntil(A, B, (s) => C(s).spawned?.dead === true || !C(s).spawned, 20, 15000, `e${civ.id}`) : { ok: false };
          const k = await until(A, 15000, (s) => (C(s).chaos ?? 0) > (C(a0).chaos ?? 0));
          await check('stars', 'B\'s civilian killed by A: A\'s crime counted', killed.ok && k.ok, { clicks: killed.clicks, chaos: [C(a0).chaos, C(k.state).chaos], wanted: k.state?.wanted });
        }
        await A.cmd('look off');
        await unwanted(A);
      },
      async population() {
        await healed();
        if (!(await together('population', PLACES.hotel, 5))) return;
        await sleep(Math.min(25000, Math.max(0, left()))); // (the streets fill)
        let [a, b] = await both();
        // (one of them killed meanwhile — a burning wreck of the scenario before, the police —: both brought back together)
        for (let again = 0; again < 2 && distance(a?.pos, b?.pos) > 30 && left() > 120000; again++) {
          console.log('POPULATION apart', JSON.stringify({ A: vec(a?.pos), B: vec(b?.pos) }));
          await healed();
          await together('population', PLACES.hotel, 5);
          await sleep(Math.min(25000, Math.max(0, left())));
          [a, b] = await both();
        }
        const ca = census(a), cb = census(b);
        await check('population', 'ambient peds and cars owned around them', ca.owned + cb.owned > 0, { A: ca, B: cb });
        await check('population', 'each has copies of the other\'s', ca.puppets > 0 && cb.puppets > 0, { A: ca, B: cb });
        const ia = netids(a), ib = netids(b);
        if (ia && ib) await check('population', 'the same network ids on both', [...ia].some((id) => ib.has(id)), { A: ia.size, B: ib.size });
        else await skip('population', 'the same network ids on both', 'the engine publishes no ids (owned.ids / puppets.ids / netids)');
        // (B goes away: what it owned near A goes to A — A's copies become its own)
        await B.cmd(tpCommand(PLACES.far));
        await until(B, 60000, (s) => distance(s?.pos, PLACES.far) < 5);
        const after = await until(A, 40000, (s) => { const c = census(s); return c.owned > ca.owned || c.puppets < ca.puppets / 2; });
        await check('population', 'B away: A owns what B had near it (or its copies go)', after.ok, { before: ca, after: census(after.state) });
        await B.cmd(tpCommand(offset(PLACES.hotel, 5)));
        await until(B, 60000, (s) => distance(s?.pos, offset(PLACES.hotel, 5)) < 5);
      },
      async world() {
        await together('world', PLACES.hotel, 6);
        if (o.admins && A.admin && B.admin) {
          // (B an ordinary player for these checks: off the list, joined again so that its engine knows)
          let list = []; try { list = JSON.parse(fs.readFileSync(o.admins, 'utf8')); } catch { /* none */ }
          fs.writeFileSync(o.admins, JSON.stringify(list.filter((u) => String(u).toLowerCase() !== B.username.toLowerCase())) + '\n');
          await B.cmd('leave');
          await until(B, 60000, (s) => s?.inWorld !== true);
          const r = await join(B);
          B.admin = !!r.state?.admin;
          await check('world', 'B joins again as an ordinary player', r.ok && !B.admin, { admin: r.state?.admin });
        }
        const admin = clients.find((c) => c.admin) ?? null, other = clients.find((c) => !c.admin) ?? null;
        if (other) {
          const before = await other.read();
          await other.cmd('cheat YOUWONTTAKEMEALIVE');
          await sleep(Math.min(6000, Math.max(0, left())));
          const after = await other.read();
          await check('world', `a cheat refused for a non-admin (${other.tag})`, (after?.wanted ?? 0) <= (before?.wanted ?? 0), { before: before?.wanted, after: after?.wanted });
          if (weatherOf(after) != null) {
            await other.cmd('cheat CATSANDDOGS'); await sleep(4000);
            const w = await other.read();
            await check('world', 'a world cheat refused for a non-admin', JSON.stringify(weatherOf(w)) === JSON.stringify(weatherOf(after)), { before: weatherOf(after), after: weatherOf(w) });
          }
        } else await skip('world', 'a cheat refused for a non-admin', 'both players are admins');
        if (admin) {
          const watcher = clients.find((c) => c !== admin);
          await admin.cmd('cheat YOUWONTTAKEMEALIVE');
          const wanted = await until(admin, 15000, (s) => (s?.wanted ?? 0) >= 2);
          await check('world', `an admin's cheat applied (${admin.tag} wanted)`, wanted.ok, { wanted: wanted.state?.wanted });
          const stars = await until(watcher, 20000, (s) => (playerIn(s, admin.name)?.stars ?? 0) >= 2);
          await check('world', 'the wanted stars shown over the admin to the other', stars.ok, { stars: playerIn(stars.state, admin.name)?.stars ?? null });
          await sleep(Math.min(20000, Math.max(0, left()))); // (the police come for the wanted player)
          const around = census(await watcher.read());
          await check('world', 'police around the wanted player seen by the other (copies)', around.puppets > 0, around);
          const s0 = await admin.read();
          if (weatherOf(s0) != null) {
            await admin.cmd('cheat CATSANDDOGS');
            const changed = await until(admin, 15000, (s) => JSON.stringify(weatherOf(s)) !== JSON.stringify(weatherOf(s0)));
            const same = await until(watcher, 15000, (s) => JSON.stringify(weatherOf(s)) === JSON.stringify(weatherOf(changed.state)));
            await check('world', 'an admin\'s world cheat applied on both', changed.ok && same.ok, { admin: weatherOf(changed.state), other: weatherOf(same.state) });
            await admin.cmd('cheat CATSANDDOGS'); // (back to the game's own weather)
          } else await skip('world', 'an admin\'s world cheat applied on both', 'the engine publishes no weather');
          // (the teleport list: for everyone, a wanted level too — once alive: the police may have killed the player)
          await until(admin, RESPAWN_MS, (s) => !dead(s) && s?.inWorld === true);
          const t0 = await admin.read();
          await admin.cmd('teleport 2');
          // (the next teleport once this one's fade is over: one asked meanwhile is not taken — the list cannot be
          // opened either while a teleport goes on)
          const p0 = await until(admin, 90000, (s) => distance(s?.pos, t0?.pos) > 20 && s?.teleporting === false);
          await admin.cmd('teleport 1');
          const p1 = await until(admin, 90000, (s) => distance(s?.pos, p0.state?.pos) > 20);
          // (the list's rows 2 and 1: mmo_social.cpp's third and second safehouses — not wherever a death or an arrest
          // by the police that came for the wanted player would put it)
          const rows = { 2: [428.4, 609.1, 12.0], 1: [-377.06, -545.43, 16.0] };
          await check('world', 'the teleport list moves the player there, wanted or not', p0.ok && p1.ok && distance(p0.state?.pos, rows[2]) < 6 && distance(p1.state?.pos, rows[1]) < 6,
            { from: vec(t0?.pos), first: vec(p0.state?.pos), second: vec(p1.state?.pos), expected: rows, wanted: [p0.state?.wanted, p1.state?.wanted] });
          await admin.cmd('cheat LEAVEMEALONE');
        } else {
          await skip('world', 'an admin\'s cheats', 'no admin (--admins <test server admins.json>)');
          const t0 = await B.read();
          await B.cmd('teleport 2');
          const p0 = await until(B, 45000, (s) => distance(s?.pos, t0?.pos) > 20);
          await check('world', 'the teleport list moves the player', p0.ok, { from: vec(t0?.pos), to: vec(p0.state?.pos) });
        }
      },
      async garage() {
        // (at the test machine's fps a teleport loads its scene for tens of seconds: generous waits)
        const stored = (s) => (s?.world?.garages ?? s?.garages ?? []).reduce((n, g) => n + (g?.record ?? 0), 0);
        const a0 = await A.read(), b0 = await B.read();
        await A.cmd(tpCommand(PLACES.garageOut));
        await until(A, 120000, (s) => distance(s?.pos, PLACES.garageOut) < 4);
        await A.cmd(`car ${o.car}`);
        const inCar = await until(A, 120000, (s) => !!s?.vehicle);
        if (!await check('garage', 'A in a car of its own', inCar.ok, { vehicle: inCar.state?.vehicle })) return;
        await A.cmd(tpCommand(PLACES.garageIn));
        await sleep(Math.min(15000, Math.max(0, left())));
        await A.cmd(`key ${o.exitKey}`);
        const out = await until(A, 90000, (s) => !s?.vehicle);
        if (!await check('garage', 'A out of the car, in the hideout', out.ok, { vehicle: out.state?.vehicle, pos: vec(out.state?.pos) })) return;
        await A.cmd(tpCommand(offset(PLACES.garageOut, -8)));
        const kept = await until(A, 240000, (s) => stored(s) > stored(a0));
        await check('garage', 'the door closed on the car: stored on the server', kept.ok, { before: stored(a0), after: stored(kept.state), garages: kept.state?.world?.garages ?? null });
        const known = await until(B, 60000, (s) => stored(s) > stored(b0));
        await check('garage', 'B knows the hideout holds A\'s car', known.ok, { before: stored(b0), after: stored(known.state) });
      },
      async perks() {
        // (the owner's rule: every character has 200 health at most and the infinite sprint; a new one starts at 200)
        const states = await everyone();
        await check('perks', 'every character: 200 health at most and the infinite sprint', states.every((s) => s?.maxHealth === 200 && s?.infiniteSprint === true),
          Object.fromEntries(clients.map((c, i) => [c.tag, { maxHealth: states[i]?.maxHealth ?? null, infiniteSprint: states[i]?.infiniteSprint ?? null, health: states[i]?.health }])));
        const P = clients[clients.length - 1], fresh = `nc-${Math.random().toString(36).slice(2, 8)}`;
        await P.cmd('leave');
        await until(P, 90000, (s) => s?.inWorld === false);
        await P.cmd(`join ${fresh}`);
        const r = await until(P, 300000, (s) => s?.inWorld === true && s?.char === fresh);
        const s = r.state;
        await check('perks', 'a new character: 200 health and the infinite sprint', r.ok && s?.health === 200 && s?.maxHealth === 200 && s?.infiniteSprint === true,
          { char: s?.char, health: s?.health, maxHealth: s?.maxHealth, infiniteSprint: s?.infiniteSprint });
        await check('perks', 'a new character: $5000 and a pistol, at the hotel', r.ok && s?.money === 5000 && (s?.weapons ?? []).some((w) => w?.[0] === 17) && distance(s?.pos, PLACES.hotel) < 5,
          { money: s?.money, weapons: s?.weapons, pos: vec(s?.pos) });
        if (r.ok) {
          // (sprinting longer than a stamina lasts: 4 s of the game's time, which empties 150 points at the test machine's fps)
          // (once the join's fade is over: the controls are the player's again)
          const spot = offset(PLACES.hotel, 3, 20);
          await P.cmd(tpCommand(spot)); await until(P, 60000, (x) => distance(x?.pos, spot) < 3);
          await until(P, 240000, (x) => x?.fade === 0);
          const s0 = await P.read();
          await P.cmd('sprint 6');
          let low = s0?.stamina ?? null, moved = 0;
          const end = Date.now() + Math.min(300000, Math.max(0, left() - 60000));
          while (Date.now() < end) {
            const x = await P.read();
            if (Number.isFinite(x?.stamina)) low = Math.min(low ?? x.stamina, x.stamina);
            moved = Math.max(moved, distance(x?.pos, s0?.pos));
            if (moved > 15) break;
            await sleep(500);
          }
          await sleep(3000);
          const s1 = await P.read();
          if (Number.isFinite(s1?.stamina)) low = Math.min(low, s1.stamina);
          await check('perks', 'a sprint does not tire (the stamina kept)', moved > 4 && Number.isFinite(low) && low >= (s0?.stamina ?? 0) - 1,
            { moved: Math.round(moved * 10) / 10, stamina: { start: s0?.stamina, lowest: low, end: s1?.stamina } });
        }
        // (the test character deleted, the player's own joined again)
        await P.cmd('leave');
        // (leaving closes the link: the menu's Multiplayer page opens it again, its character list)
        await until(P, 120000, (x) => x?.inWorld === false && x?.menuActive === true);
        await P.cmd('mpmenu');
        const listedAgain = await until(P, 90000, (x) => x?.lobby?.valid === true && (x.lobby.characters ?? []).some((c) => c?.name === fresh));
        if (!listedAgain.ok) console.log('LOBBY', JSON.stringify({ lobby: listedAgain.state?.lobby ?? null, menu: listedAgain.state?.lobbyMenu ?? null }));
        await P.cmd(`mpdelete ${fresh}`);
        const gone = await until(P, 30000, (x) => !(x?.lobby?.characters ?? []).some((c) => c?.name === fresh));
        await check('perks', 'the test character deleted', gone.ok, { characters: (gone.state?.lobby?.characters ?? []).map((c) => c?.name) });
        const back = await join(P);
        P.slot = back.state?.slot ?? P.slot;
        await check('perks', `${P.tag} joins again as ${P.name}`, back.ok && back.state?.char === P.name, { char: back.state?.char });
      },
      async crowd() {
        // (three players or more together: every one sees every other, its lines, its stars; the shared entities owned
        // once; a fight watched by a third; one leaving and coming back; a world cheat and a garage known by all)
        const N = clients.length, [C] = clients.slice(2);
        const listed = await untilAll(60000, (st) => clients.every((c, i) => clients.every((d) => d === c || !!playerIn(st[i], d.name))));
        await check('crowd', `each lists the ${N - 1} others`, listed.ok, Object.fromEntries(clients.map((c, i) => [c.tag, (listed.states[i]?.players ?? []).map((p) => p.name)])));
        // -- all gathered at one place
        async function gather(place) {
          const spots = gathering(place, N, 3);
          for (const [i, c] of clients.entries()) await c.cmd(tpCommand(spots[i]));
          const there = await untilAll(90000, (st) => st.every((s, i) => distance(s?.pos, spots[i]) < 3));
          if (!there.ok) { await check('crowd', 'all teleported together', false, Object.fromEntries(clients.map((c, i) => [c.tag, vec(there.states[i]?.pos)]))); return false; }
          const seen = await untilAll(60000, (st) => crowdSight(clients, st).every((x) => x.ok));
          const sight = crowdSight(clients, seen.states);
          return check('crowd', 'each sees every other where it is (2 m), a copy with its name', seen.ok, { failing: sight.filter((x) => !x.ok), pairs: sight.length });
        }
        await healedAll();
        await gather(PLACES.hotel);
        // -- every player's line seen by all
        const tag = Math.random().toString(36).slice(2, 7);
        for (const c of clients) await c.cmd(`say crowd ${c.tag} ${tag}`);
        const lines = await untilAll(60000, (st) => st.every((s) => clients.every((c) => chatHas(s, `crowd ${c.tag} ${tag}`))));
        await check('crowd', 'every player\'s line seen by all', lines.ok,
          Object.fromEntries(clients.map((c, i) => [c.tag, clients.filter((d) => !chatHas(lines.states[i], `crowd ${d.tag} ${tag}`)).map((d) => d.tag)])));
        // -- the shared entities: one owner each, copies on the others near them, no copy of nobody's
        await sleep(Math.min(20000, Math.max(0, left()))); // (the streets fill)
        const audits = [];
        for (let i = 0; i < 6; i++) {
          const st = await everyone();
          audits.push(entityAudit(clients.map((c, k) => ({ tag: c.tag, slot: c.slot, state: st[k] }))));
          await sleep(2500);
        }
        const last = audits[audits.length - 1], faults = persistentFaults(audits), counts = (await everyone()).map(census);
        await check('crowd', 'shared peds and cars present (owned here, copies there)', counts.some((x) => x.owned > 0) && counts.filter((x) => x.puppets > 0).length >= N - 1,
          Object.fromEntries(clients.map((c, i) => [c.tag, counts[i]])));
        await check('crowd', 'every network id owned by one client only (no duplicate)', faults.duplicates.length === 0,
          { duplicates: faults.duplicates.map((id) => ({ id, owners: last.owners[id] })), lastSample: last.duplicates.length });
        await check('crowd', 'no copy of an entity nobody owns (no ghost)', last.complete ? faults.ghosts.length === 0 : true,
          { ghosts: faults.ghosts.slice(0, 20), complete: last.complete, lastSample: last.ghosts.length });
        await check('crowd', 'every copy names its real owner', faults.wrongOwner.length === 0, { wrongOwner: faults.wrongOwner.slice(0, 20), lastSample: last.wrongOwner.length });
        const cov = audits.reduce((b, a) => (a.coverage.expected && a.coverage.present / a.coverage.expected > (b.coverage.expected ? b.coverage.present / b.coverage.expected : -1) ? a : b), audits[0]).coverage;
        await check('crowd', 'an entity near another player is a copy there (80 % or more)', cov.expected > 0 && cov.present / cov.expected >= 0.8,
          { expected: cov.expected, present: cov.present, missing: cov.missing.slice(0, 15) });
        // -- the wanted stars of one, seen by every other
        await A.cmd('cheat YOUWONTTAKEMEALIVE');
        const wanted = await until(A, 30000, (s) => (s?.wanted ?? 0) >= 2);
        const stars = await untilAll(40000, (st) => clients.every((c, i) => c === A || (playerIn(st[i], A.name)?.stars ?? 0) >= 2));
        await check('crowd', 'an admin\'s wanted level: its stars seen by every other', wanted.ok && stars.ok,
          { wanted: wanted.state?.wanted, stars: Object.fromEntries(clients.map((c, i) => [c.tag, playerIn(stars.states[i], A.name)?.stars ?? null])) });
        await A.cmd('cheat LEAVEMEALONE');
        await until(A, 30000, (s) => (s?.wanted ?? 0) === 0);
        // -- a fight: A kills B, C watches
        await healedAll();
        await gather(PLACES.hotel);
        const b0 = await B.read();
        if (!Number.isFinite(b0?.money) || b0.money < 200) { await B.cmd('money 1000'); await until(B, 15000, (s) => s?.money === 1000); }
        await A.cmd(`weapon ${o.weapon} 500`);
        await until(A, 15000, (s) => s?.weapon === o.weapon);
        await A.cmd(`aim ${B.slot}`); await sleep(1000);
        let start = await B.read(), beforeDeath = start, killed = false, hurt = false, shots = 0;
        for (; shots < 150 && left() > 120000 && !killed; shots++) {
          if (shots % 8 === 7) await A.cmd(`aim ${B.slot}`);
          const f0 = (await A.read())?.combat?.fires ?? 0;
          await A.cmd(`fire ${B.slot}`);
          await until(A, 30000, (sa) => (sa?.combat?.fires ?? 0) > f0);
          const s = await B.read();
          if (!dead(s)) beforeDeath = s;
          if (Number.isFinite(s?.health) && s.health < start.health) hurt = true;
          if (dead(s)) killed = true;
        }
        await check('crowd', 'A\'s shots hurt B, B dies', hurt && killed, { shots, start: start?.health, last: beforeDeath?.health });
        if (killed) {
          const deathPos = vec(beforeDeath?.pos);
          const feed = await untilAll(60000, (st) => st.every((s) => !!killLine(s, B.name, A.name)));
          await check('crowd', 'the kill line on every player (the watcher too)', feed.ok, Object.fromEntries(clients.map((c, i) => [c.tag, killLine(feed.states[i], B.name) ?? (feed.states[i]?.chat ?? []).slice(-3)])));
          const respawned = await until(B, RESPAWN_MS, (s) => !dead(s) && distance(s?.pos, deathPos) > 5 && s?.inWorld !== false && Number.isFinite(s?.health) && s.health > 0);
          for (const r of respawnChecks(beforeDeath, deathPos, respawned.state)) await check('crowd', r.name, r.ok && respawned.ok, r.detail);
          await check('crowd', 'respawn: 200 health (the new rule)', respawned.ok && respawned.state?.health === 200, { health: respawned.state?.health, maxHealth: respawned.state?.maxHealth });
          const watched = await untilAll(60000, (st) => clients.every((c, i) => c === B || distance(playerIn(st[i], B.name)?.pos, respawned.state?.pos) < 3));
          await check('crowd', 'every other sees B where it respawned', watched.ok, Object.fromEntries(clients.map((c, i) => [c.tag, c === B ? null : seesAt(watched.states[i], respawned.state, B.name)])));
        }
        // -- one leaves (the last: C or D): the others drop it and take over its entities; it comes back to its place
        const L = clients[N - 1], stay = clients.filter((c) => c !== L);
        await healedAll();
        await gather(PLACES.hotel);
        await sleep(Math.min(15000, Math.max(0, left())));
        const money = 3000 + Math.floor(Math.random() * 999), spot = offset(PLACES.hotel, 7, 6);
        await L.cmd(`money ${money}`); await L.cmd(tpCommand(spot));
        await until(L, 30000, (s) => s?.money === money && distance(s?.pos, spot) < 3);
        await sleep(Math.min(12000, Math.max(0, left()))); // (the character saved)
        const before = await everyone();
        const lAudit = entityAudit(clients.map((c, k) => ({ tag: c.tag, slot: c.slot, state: before[k] })));
        const lOwned = Object.keys(lAudit.owners).filter((id) => lAudit.owners[id].includes(L.tag)).map(Number);
        const copiedElsewhere = lOwned.filter((id) => stay.some((c, k) => netids(before[clients.indexOf(c)], 'puppets')?.has(id)));
        await L.cmd('leave');
        const out = await until(L, 90000, (s) => s?.inWorld === false);
        const dropped = await untilAll(40000, (st) => st.every((s) => !playerIn(s, L.name)), stay);
        await check('crowd', `${L.tag} leaves: every other drops it`, out.ok && dropped.ok, Object.fromEntries(stay.map((c, i) => [c.tag, (dropped.states[i]?.players ?? []).map((p) => p.name)])));
        await sleep(Math.min(8000, Math.max(0, left())));
        const takeover = await untilAll(40000, (st) => {
          const a = entityAudit(stay.map((c, k) => ({ tag: c.tag, slot: c.slot, state: st[k] })));
          return copiedElsewhere.every((id) => (a.owners[id]?.length ?? 0) === 1 || !stay.some((c, k) => netids(st[k], 'puppets')?.has(id)));
        }, stay);
        const ta = entityAudit(stay.map((c, k) => ({ tag: c.tag, slot: c.slot, state: takeover.states[k] })));
        const taken = copiedElsewhere.filter((id) => ta.owners[id]?.length === 1).length;
        const stillCopies = copiedElsewhere.filter((id) => !ta.owners[id] && stay.some((c, k) => netids(takeover.states[k], 'puppets')?.has(id)));
        await check('crowd', `${L.tag}'s entities taken over by those who stay (none left a copy of nobody's)`, takeover.ok && (copiedElsewhere.length === 0 || taken > 0),
          { owned: lOwned.length, copiedElsewhere: copiedElsewhere.length, takenOver: taken, stillCopies: stillCopies.slice(0, 20), duplicates: ta.duplicates });
        const again = await join(L);
        const kept = await until(L, 60000, (s) => s?.money === money && distance(s?.pos, spot) < 5);
        await check('crowd', `${L.tag} joins again: its money and its place`, again.ok && kept.ok, { money: kept.state?.money, pos: vec(kept.state?.pos), expected: { money, pos: spot } });
        L.slot = kept.state?.slot ?? again.state?.slot ?? L.slot;
        const relisted = await untilAll(60000, (st) => clients.every((c, i) => c === L || !!playerIn(st[i], L.name)));
        await check('crowd', `every other lists ${L.tag} again`, relisted.ok, {});
        // -- a world cheat on every player
        const w0 = await everyone();
        if (weatherOf(w0[0]) != null) {
          await A.cmd('cheat CATSANDDOGS');
          const changed = await until(A, 20000, (s) => JSON.stringify(weatherOf(s)) !== JSON.stringify(weatherOf(w0[0])));
          const same = await untilAll(30000, (st) => st.every((s) => JSON.stringify(weatherOf(s)) === JSON.stringify(weatherOf(changed.state))));
          await check('crowd', 'an admin\'s world cheat applied on every player', changed.ok && same.ok, Object.fromEntries(clients.map((c, i) => [c.tag, weatherOf(same.states[i])])));
          await A.cmd('cheat CATSANDDOGS');
          await untilAll(20000, (st) => st.every((s) => JSON.stringify(weatherOf(s)) === JSON.stringify(weatherOf(w0[0]))));
        } else await skip('crowd', 'an admin\'s world cheat applied on every player', 'the engine publishes no weather');
        // -- a garage: a car stored by C (or B), known by every player
        const G = C ?? B, stored = (s) => (s?.world?.garages ?? s?.garages ?? []).reduce((n, g) => n + (g?.record ?? 0), 0);
        const g0 = await everyone();
        await G.cmd(tpCommand(PLACES.garageOut));
        await until(G, 120000, (s) => distance(s?.pos, PLACES.garageOut) < 4);
        await G.cmd(`car ${o.car}`);
        const inCar = await until(G, 120000, (s) => !!s?.vehicle);
        if (!await check('crowd', `${G.tag} in a car of its own (garage)`, inCar.ok, { vehicle: inCar.state?.vehicle })) return;
        await G.cmd(tpCommand(PLACES.garageIn));
        await sleep(Math.min(15000, Math.max(0, left())));
        // (a scene loading in one page slows them all — one GPU process —: down to 0.1 frame a second, the exit key
        // pressed again while the player is still in)
        let outCar = { ok: false };
        for (let i = 0; i < 3 && !outCar.ok && left() > 120000; i++) { await G.cmd(`key ${o.exitKey}`); outCar = await until(G, 120000, (s) => !s?.vehicle); }
        if (!await check('crowd', `${G.tag} out of the car, in the hideout`, outCar.ok, { vehicle: outCar.state?.vehicle, pos: vec(outCar.state?.pos) })) return;
        await G.cmd(tpCommand(offset(PLACES.garageOut, -8)));
        const keptCar = await until(G, 240000, (s) => stored(s) > stored(g0[clients.indexOf(G)]));
        const known = await untilAll(60000, (st) => st.every((s, i) => stored(s) > stored(g0[i])));
        await check('crowd', `a car stored by ${G.tag} known by every player`, outCar.ok && keptCar.ok && known.ok,
          { before: g0.map(stored), after: known.states.map(stored) });
      },
      async freemode() {
        // (one page, no shared world: the game's free mode from its main menu, then "teleport" typed, a place chosen
        // with the arrows and Enter, the player moved there)
        const [P] = clients;
        // (the keys check.mjs --keys gives — ArrowDown, Enter, Enter —, each sent again until the menu shows it was read:
        // the menu's page and row, lobbyMenu in the engine's state)
        const menu = await until(P, 120000, (s) => s?.menuActive === true && s?.lobbyMenu?.page === 'start' && (s.lobbyMenu.rows ?? []).includes('ORT_FRE'));
        if (!await check('freemode', 'the main menu', menu.ok, { menuActive: menu.state?.menuActive, menu: menu.state?.lobbyMenu ?? null })) return;
        const row = menu.state.lobbyMenu.rows.indexOf('ORT_FRE');
        let r = { ok: false };
        for (let i = 0; i < 6 && !r.ok; i++) { await P.cmd('key DOWN'); r = await until(P, 20000, (s) => s?.lobbyMenu?.cursor === row); }
        for (let i = 0; i < 6 && r.ok; i++) { await P.cmd('key ENTER'); r = await until(P, 20000, (s) => s?.lobbyMenu?.page !== 'start'); if (r.ok) break; }
        await check('freemode', 'the menu\'s free mode page (ArrowDown, Enter)', r.ok, { menu: r.state?.lobbyMenu ?? null });
        await sleep(3000);
        await P.cmd('key ENTER'); // (its first row: Continue — a new free game on a new profile)
        const inGame = await until(P, 400000, (s) => !!vec(s?.freeMode?.pos) && s?.menuActive === false);
        if (!await check('freemode', 'the free mode: a player in the city', inGame.ok, { freeMode: inGame.state?.freeMode ?? null, menuActive: inGame.state?.menuActive })) return;
        await sleep(Math.min(20000, Math.max(0, left()))); // (the start's fade)
        const p0 = vec((await P.read())?.freeMode?.pos);
        await P.cmd('cheat TELEPORT');
        const open = await until(P, 60000, (s) => s?.teleportList === true);
        if (!await check('freemode', '"teleport" typed opens the list', open.ok, { teleportList: open.state?.teleportList })) return;
        await P.cmd('key DOWN'); await sleep(3000); await P.cmd('key ENTER');
        const closed = await until(P, 60000, (s) => s?.teleportList === false);
        // (the list's second row: the safehouses' second, the Vercetti Estate — mmo_social.cpp's list)
        const estate = [-377.06, -545.43, 16.0];
        const moved = await until(P, 180000, (s) => distance(s?.freeMode?.pos, p0) > 20 && s?.teleporting === false);
        await check('freemode', 'a place chosen with the arrows and Enter: the player moved there', closed.ok && moved.ok && distance(moved.state?.freeMode?.pos, estate) < 6,
          { from: p0, to: vec(moved.state?.freeMode?.pos), expected: estate, dist: Math.round(distance(moved.state?.freeMode?.pos, estate) * 10) / 10 });
      },
    };
    /** every player alive and healed (the health cheat: all are administrators of the test server) */
    async function healedAll() {
      for (const c of clients) {
        await until(c, RESPAWN_MS, (s) => !dead(s) && Number.isFinite(s?.health) && s.health > 0 && s?.inWorld !== false);
        await c.cmd('cheat ASPIRINE');
      }
      await untilAll(30000, (st) => st.every((s) => s?.health >= 99));
    }
    for (const name of o.scenarios) {
      if (left() < 30000) { await check(name, 'run', false, { why: 'out of time (--seconds)' }); continue; }
      console.log('SCENARIO', name);
      try { await scenarios[name](); } catch (error) { await check(name, 'run', false, { error: error.message }); }
    }
    // (each page's link over the run: what a player's connection carried, in bytes a second)
    const secs = Math.max(1, (Date.now() - started) / 1000);
    const links = await Promise.all(clients.map((c) => c.read().then((s) => s?._page?.stats ?? null).catch(() => null)));
    console.log('BANDWIDTH', JSON.stringify(Object.fromEntries(clients.map((c, i) => [c.tag, links[i] && {
      upBs: Math.round(links[i].sentBytes / secs), downBs: Math.round(links[i].receivedBytes / secs), connections: links[i].connections }]))));
    for (const c of clients) await c.cmd('leave').catch(() => {});
    await sleep(2000);
  } catch (error) {
    await check('setup', 'run', false, { error: error.message });
  } finally {
    clearInterval(heartbeat);
    const summary = { manifest: o.manifest, url: o.url, seconds: Math.round((Date.now() - started) / 1000), out, ...summarize(checks) };
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ summary, checks }, null, 1));
    console.log('RESULTS', JSON.stringify(summary));
    await browser.close().catch(() => {});
    process.exitCode = summary.passed ? 0 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error('FAILED', error?.stack ?? error); process.exitCode = 1; });
}
