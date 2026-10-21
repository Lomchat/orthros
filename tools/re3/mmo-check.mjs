// Two-client check of an re3 port's shared world (docs/mmo.md, section 8): one Chromium, two browser contexts — two
// devices, each signed in to its own Orthros account (the QA accounts of /tmp/orthros-scratch/qa-accounts.json, shared
// with tools/re3/check.mjs and tools/goldsrc/check.mjs; made through the account API when missing) — each on the
// version's play page with ?mmotest, small windows. The engine then reads one test command a frame
// (window.orthrosMmo.command) and publishes its state every 500 ms (window.orthrosMmo.state: mode, link, slot, admin,
// inWorld, pos, health, money, wanted, weapon, vehicle, players, owned, puppets, chat…); every step here is a command,
// every check a wait on those states, every wait bounded (and the whole run by --seconds).
//
// Scenarios (--scenario, a comma list or all; both players join first, whatever the scenario):
//   basic       each sees the other at its place (2 m), away from the page shown to the other, leave + join again keeps
//               the money and the place, a dropped connection comes back (the engine joins again) — a server restart's
//               effect on the page
//   chat        a line each way, seen by both
//   combat      shots from A hurt B, B dies, respawns ($100 less, no weapon, elsewhere), A sees B there
//   population  ambient peds and cars around both: owned by one, copies on the other; B leaves: A's copies become its own
//   world       cheats: refused for a non-admin, an admin's wanted level shown to the other (stars), world cheats on both
//               (when the engine publishes `weather`), the teleport list
//   garage      a car stored in a hideout by A, found there by B
// Results: one CHECK line (JSON) per check, RESULTS (JSON) at the end; exit 0 when every check passed. On a failed check
// both pages are photographed, with their last states and logs, under /tmp/orthros-scratch/mmo-check/<run>/.
//
// Start it through the browser slot guard (CLAUDE.md, "Shared server budget"):
//   tools/with-browser-slot.sh node tools/re3/mmo-check.mjs [vice-city-orthros] --url http://127.0.0.1:8080
//     [--seconds 900] [--scenario basic|chat|combat|population|world|garage|all] [--admins <test server's admins.json>]
//     [--lang en] [--skin <model>] [--weapon 26] [--car 130] [--exit-key f] [--width 480 --height 300]
// --admins: the first player made an admin of the test server (its <mmo dir>/admins.json, re-read by the server) before
// it joins; never the live server's. Without it, the admin checks are skipped.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const SCENARIOS = Object.freeze(['basic', 'chat', 'combat', 'combatx', 'combatp', 'combatv', 'population', 'world', 'garage']);
export const OUT_ROOT = '/tmp/orthros-scratch/mmo-check';
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
  return {
    manifest: positional[0] ?? 'vice-city-orthros',
    url: String(opt('url', 'http://127.0.0.1:8080')).replace(/\/+$/, ''),
    seconds: num('seconds', 900, 30, 7200),
    scenarios: scenarioList(opt('scenario', 'all')),
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
const VALUED = new Set(['url', 'seconds', 'scenario', 'admins', 'lang', 'skin', 'weapon', 'car', 'exit-key', 'width', 'height']);
/** 'all', one scenario or a comma list → the scenarios in their order. */
export function scenarioList(text) {
  const wanted = String(text).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!wanted.length || wanted.includes('all')) return [...SCENARIOS];
  for (const s of wanted) if (!SCENARIOS.includes(s)) throw new Error(`unknown scenario ${s} (${SCENARIOS.join(', ')}, all)`);
  return SCENARIOS.filter((s) => wanted.includes(s));
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
    const known = qa[i];
    const account = known ?? { username: `qa-check-${i + 1}-${Math.random().toString(36).slice(2, 7)}`, password: Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('') };
    const result = await page.evaluate(async ({ a, create }) => {
      const r = await fetch(create ? '/api/account/register' : '/api/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: a.username, password: a.password }) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, { a: account, create: !known });
    if (result.status !== 200) throw new Error(`QA account ${account.username}: ${result.status} ${JSON.stringify(result.body)}`);
    if (!known) { qa[i] = account; let all = {}; try { all = JSON.parse(fs.readFileSync(qaFile, 'utf8')); } catch { /* new */ } all[o.url] = qa; fs.writeFileSync(qaFile, JSON.stringify(all, null, 1), { mode: 0o600 }); }
    const world = await page.evaluate((id) => fetch(`/api/mmo/${encodeURIComponent(id)}`, { cache: 'no-store' }).then((r) => r.json()).catch((e) => ({ error: e.message })), o.manifest);
    await page.close();
    return { username: result.body?.user?.username ?? account.username, world };
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, channel: 'chromium', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const heartbeat = setInterval(async () => {
    const line = [];
    for (const c of clients) line.push(await c.read().then((s) => ({ c: c.tag, mode: s?.mode, link: s?._page?.link, inWorld: s?.inWorld, fps: s?.fps, updates: s?._page?.updates })).catch(() => ({ c: c.tag, closed: true })));
    console.log('PROGRESS', Math.round((Date.now() - started) / 1000), JSON.stringify(line));
  }, 15000);
  try {
    // ---- two devices, two players
    for (const [i, tag] of [[0, 'A'], [1, 'B']]) {
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
    if (!A.world?.enabled) throw new Error(`the server's world for ${o.manifest} is not enabled: ${JSON.stringify(A.world)}`);
    if (o.admins) {
      if (!adminsPathAllowed(o.admins)) throw new Error(`--admins ${o.admins}: not the live server's state — give the test server's <mmo dir>/admins.json`);
      let list = []; try { list = JSON.parse(fs.readFileSync(o.admins, 'utf8')); } catch { /* new */ }
      fs.mkdirSync(path.dirname(path.resolve(o.admins)), { recursive: true });
      // (both: in a shared world the test commands that set a player's state — money, tp, weapon, car — are an
      // administrator's only, like the cheats; the world scenario takes B's rights away for its non-admin checks)
      fs.writeFileSync(o.admins, JSON.stringify(withAdmin(withAdmin(list, A.username), B.username)) + '\n');
      console.log('ADMIN', A.username, B.username, 'in', o.admins);
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
    for (const c of clients) {
      const r = await join(c);
      c.slot = r.state?.slot;
      if (!await check('setup', `${c.tag} joins the world as ${c.name}`, r.ok, { slot: r.state?.slot, admin: r.state?.admin, refused: r.refused ?? null, mode: r.state?.mode })) throw new Error(`${c.tag} could not join`);
      c.admin = !!r.state?.admin;
    }
    {
      const [a, b] = await both();
      await check('setup', 'the players have their own slots', Number.isFinite(a?.slot) && Number.isFinite(b?.slot) && a.slot !== b.slot, { A: a?.slot, B: b?.slot });
      A.slot = a?.slot; B.slot = b?.slot;
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
        await until(c, 400000, (s) => !dead(s) && Number.isFinite(s?.health) && s.health > 0 && s?.inWorld !== false);
        await c.cmd('cheat ASPIRINE');
      }
      await untilBoth(20000, (a, b) => a?.health >= 99 && b?.health >= 99);
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
        const respawned = await until(B, 400000, (s) => !dead(s) && distance(s?.pos, deathPos) > 5 && s?.inWorld !== false);
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
        const respawned = await until(B, 400000, (s) => !dead(s) && s?.health > 0 && s?.inWorld !== false && Number.isFinite(s?.health) && s.health >= 99);
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
        const dump = async (tag) => { const [a, b] = await both(); console.log('COMBAT', tag, JSON.stringify({ A: { h: a?.health, m: a?.money, seen: a?.combat?.seen, pk: a?.combat?.pickups, pr: a?.combat?.projectiles, ev: a?.combat?.eventsSent }, B: { h: b?.health, m: b?.money, seen: b?.combat?.seen, pk: b?.combat?.pickups, pr: b?.combat?.projectiles, dead: b?.dead, blast: b?.combat?.lastBlast, fn: b?.combat?.flameNearest, ign: b?.combat?.ignitions, me: b?.combat?.me, wanted: b?.wanted, pos: b?.pos }, Apos: a?.pos })); return [a, b]; };
        if (!(await together('combatp', PLACES.hotel, 4))) return;
        await dump('start');
        // pickups
        const [a0, b0] = await both();
        await A.cmd('pickup 10');
        const made = await until(B, 30000, (s) => (s?.combat?.seen?.pickupsMade ?? 0) > (b0?.combat?.seen?.pickupsMade ?? 0));
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
        // a flame
        const b3 = await B.read();
        if (!dead(b3)) {
          await A.cmd('weapon 31 500');
          await until(A, 15000, (s) => s?.weapon === 31);
          for (let i = 0; i < 6; i++) { await A.cmd(`fire ${B.slot}`); await sleep(400); }
          const flames = await until(B, 30000, (s) => (s?.combat?.seen?.flames ?? 0) > (b3?.combat?.seen?.flames ?? 0));
          const burnt = await until(B, 40000, (s) => Number.isFinite(s?.health) && s.health < b3.health);
          await dump('flame');
          await check('combatp', 'A\'s flames seen by B, B burns', flames.ok && burnt.ok, { flames: flames.ok, health: [b3?.health, burnt.state?.health] });
        } else await skip('combatp', 'A\'s flames seen by B, B burns', 'B dead from the grenade');
        // a grenade
        await A.cmd('weapon 12 10');
        await until(A, 15000, (s) => s?.weapon === 12);
        const [, b2] = await dump('grenade armed');
        await A.cmd(`fire ${B.slot}`);
        const proj = await until(B, 30000, (s) => (s?.combat?.seen?.projectiles ?? 0) > (b2?.combat?.seen?.projectiles ?? 0));
        const blast = await until(B, 40000, (s) => (s?.combat?.seen?.explosions ?? 0) > (b2?.combat?.seen?.explosions ?? 0));
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
        // A runs into B
        let rammed = false;
        for (let i = 0; i < 3 && !rammed; i++) {
          const bh = await B.read();
          await A.cmd(`ram ${B.slot} 0.35`);
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
      async population() {
        await healed();
        if (!(await together('population', PLACES.hotel, 5))) return;
        await sleep(Math.min(25000, Math.max(0, left()))); // (the streets fill)
        const [a, b] = await both();
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
          // (the teleport list: for everyone, a wanted level too)
          const t0 = await admin.read();
          await admin.cmd('teleport 2');
          const p0 = await until(admin, 45000, (s) => distance(s?.pos, t0?.pos) > 20);
          await admin.cmd('teleport 1');
          const p1 = await until(admin, 45000, (s) => distance(s?.pos, p0.state?.pos) > 20);
          await check('world', 'the teleport list moves the player, wanted or not', p0.ok && p1.ok, { from: vec(t0?.pos), first: vec(p0.state?.pos), second: vec(p1.state?.pos), wanted: p1.state?.wanted });
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
    };
    for (const name of o.scenarios) {
      if (left() < 30000) { await check(name, 'run', false, { why: 'out of time (--seconds)' }); continue; }
      console.log('SCENARIO', name);
      try { await scenarios[name](); } catch (error) { await check(name, 'run', false, { error: error.message }); }
    }
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
