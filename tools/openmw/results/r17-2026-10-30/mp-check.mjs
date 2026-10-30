// Two-client check of the OpenMW cooperative path on one engine release (the r17 validation's harness, kept with its
// results: rebuilt 2026-10-30 from the session's own record of the scratch script lost with /tmp at the reboot):
// a scratch native gateway (tools/openmw/server.mjs --port, its own state dir), a scratch Orthros server (this tree,
// its own accounts dir, a scratch games folder with the version's engine replaced and its gateway port moved), one
// Chromium, two isolated contexts with their own Orthros accounts, each launched through /api/openmw/<id>/launch and
// the upstream launcher (a new character, QA ?start=<cell>), A opens its world to Party, A and B become friends, B
// joins A's world; each sees the other (roster, puppet), A walks (W), B sees A's puppet move, then B walks, A sees.
// The WebSocket events that reached the page while the engine was suspended (JSPI) are counted on each page.
// tools/with-browser-slot.sh node mp-check.mjs <tree> <engine> <out dir> --pristine <dir with learn/ and brcache/>
//   --engines-dir <dir holding <engine> and the live releases> [--manifest morrowind-goty-en] [--cell -2,-9] [--seconds 900]
//   [--port 18951] [--gw-port 28951]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2), [tree, engine, out] = argv;
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const id = opt('manifest', 'morrowind-goty-en'), cell = opt('cell', '-2,-9'), limitS = Number(opt('seconds', 900));
const OP = Number(opt('port', 18951)), GW = Number(opt('gw-port', 28951));
const pristine = path.resolve(opt('pristine', '')), enginesDir = path.resolve(opt('engines-dir', '/srv/orthros/data/engines'));
if (!opt('pristine') || pristine.startsWith('/var/lib')) throw new Error('--pristine: a scratch copy of the learned state and br-cache, never the live state');
const S = path.resolve(out); fs.rmSync(S, { recursive: true, force: true }); fs.mkdirSync(S, { recursive: true });
const t0 = Date.now(), log = (...a) => { const l = `[${((Date.now() - t0) / 1000).toFixed(1)}] ${a.join(' ')}`; console.log(l); fs.appendFileSync(path.join(S, 'run.log'), l + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { scratchGames, clearScratchGames } = await import(path.join(tree, 'tools/openmw/place-load.mjs'));
const { chromium } = await import(path.join(tree, 'node_modules/playwright/index.mjs'));
const kids = [];
const result = { engine, manifest: id, tree, checks: {}, pages: {}, faults: [] };
const check = (k, ok, detail) => { result.checks[k] = { ok: !!ok, ...(detail === undefined ? {} : { detail }) }; log('CHECK', k, ok ? 'ok' : 'FAILED', detail === undefined ? '' : JSON.stringify(detail).slice(0, 400)); };
let games = null, browser = null;
try {
  // ---- the games folder: the version on `engine`, its gateway on the scratch port
  games = scratchGames({ live: '/srv/orthros/data/games', out: path.join(S, 'games'), version: id, engine });
  const manFile = path.join(games.out, games.game, 'manifest.json'), man = JSON.parse(fs.readFileSync(manFile, 'utf8'));
  for (const v of man.versions) if (v.id === id) v.openmw.multiplayer.port = GW;
  fs.writeFileSync(manFile, JSON.stringify(man, null, 2) + '\n');
  // ---- the gateway (its container named after the port; the live games folder read only)
  const gw = spawn(process.execPath, [path.join(tree, 'tools/openmw/server.mjs'), id, '--state-dir', path.join(S, 'gw'), '--origin', `http://127.0.0.1:${OP}`, '--port', String(GW)], { cwd: tree, stdio: ['ignore', fs.openSync(path.join(S, 'gateway.log'), 'a'), fs.openSync(path.join(S, 'gateway.log'), 'a')] });
  kids.push(gw);
  for (let i = 0; ; i++) {
    const ok = await fetch(`http://127.0.0.1:${GW}/healthz`).then((r) => r.ok).catch(() => false);
    if (ok) break; if (i > 120 || gw.exitCode !== null) throw new Error('gateway not up (gateway.log)'); await sleep(1000);
  }
  log('gateway up on', GW);
  const operator = { name: 'orthros@localhost.invalid', password: crypto.randomBytes(24).toString('base64url') };
  const setup = await fetch(`http://127.0.0.1:${GW}/admin/api/setup/owner`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(operator) });
  log('operator setup', setup.status);
  fs.mkdirSync(path.join(S, 'accounts'), { recursive: true });
  fs.writeFileSync(path.join(S, 'accounts', 'openmw.json'), JSON.stringify({ secret: crypto.randomBytes(32).toString('base64url'), operators: { [id]: operator } }), { mode: 0o600 });
  // ---- the Orthros server
  fs.cpSync(path.join(pristine, 'learn'), path.join(S, 'learn'), { recursive: true });
  const srv = spawn(process.execPath, [path.join(tree, 'src/host/server.js'), '--port', String(OP), '--games-dir', games.out, '--engines-dir', enginesDir,
    '--accounts', path.join(S, 'accounts'), '--learn', path.join(S, 'learn'), '--telemetry', path.join(S, 'tel'), '--br-cache', path.join(pristine, 'brcache'), '--br-cache-frozen', '--covers', 'off', '--no-home-preload'],
  { cwd: tree, stdio: ['ignore', fs.openSync(path.join(S, 'server.log'), 'a'), fs.openSync(path.join(S, 'server.log'), 'a')] });
  kids.push(srv);
  for (let i = 0; ; i++) { if (await fetch(`http://127.0.0.1:${OP}/api/manifests`).then((r) => r.ok).catch(() => false)) break; if (i > 60 || srv.exitCode !== null) throw new Error('server not up'); await sleep(1000); }
  const origin = `http://127.0.0.1:${OP}`;
  log('server up', origin);
  if (argv.includes('--setup-only')) {
    // (no browser: an account registered and launched from Node, the gateway's ticket checked)
    const u = { username: `qa-mp-x-${crypto.randomBytes(3).toString('hex')}`, password: crypto.randomBytes(18).toString('hex') };
    const r = await fetch(origin + '/api/account/register', { method: 'POST', headers: { 'Content-Type': 'application/json', origin }, body: JSON.stringify(u) });
    const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    log('register', r.status, cookie ? 'cookie' : 'no cookie');
    const l = await fetch(origin + `/api/openmw/${id}/launch`, { method: 'POST', headers: { cookie, origin } });
    const body = await l.json().catch(() => ({}));
    log('launch', l.status, JSON.stringify(Object.fromEntries(Object.entries(body).map(([k, v]) => [k, k === 'username' || k === 'error' ? v : typeof v]))));
    const j = await fetch(origin + `/ports/openmw/${id}/app/join`, { headers: { cookie }, redirect: 'manual' });
    log('join page', j.status, (await j.text()).length);
    check('setup', l.status === 200 && body.ticket, null);
    throw new Error('setup only');
  }

  browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
  const clients = [];
  for (const tag of ['A', 'B']) {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    // (the engine page: a new character's chargen replaced by QA's ?start=<cell>; the WebSocket events counted, and
    // those that reached the page while the engine was suspended or its put-off calls not run yet)
    await ctx.addInitScript(({ cell }) => {
      if (!/\/app\/index\.html$/.test(location.pathname)) return;
      if (/mpnew=1/.test(location.hash) && !/[?&]start=/.test(location.search)) { location.replace(location.pathname + '?start=' + encodeURIComponent(cell) + location.hash.replace(/&mpnew=1/, '')); return; }
      const W = window.__mpWs = { msgs: 0, busy: 0, closes: 0, busyCloses: 0, opens: 0, busyOpens: 0, errors: 0, maxBusyRun: 0, run: 0 };
      // (by listeners added at the socket's construction — before any handler property —: nothing of the page's or the
      // engine's own handling changed; `busy`: the engine suspended or its put-off calls not run yet at the event's arrival)
      const Native = window.WebSocket;
      window.WebSocket = function (url, protocols) {
        const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
        const busyNow = () => typeof window.Module?.orthrosEngineBusy === 'function' && window.Module.orthrosEngineBusy();
        ws.addEventListener('message', () => { W.msgs++; if (busyNow()) { W.busy++; W.run++; W.maxBusyRun = Math.max(W.maxBusyRun, W.run); } else W.run = 0; });
        ws.addEventListener('open', () => { W.opens++; if (busyNow()) W.busyOpens++; });
        ws.addEventListener('close', () => { W.closes++; if (busyNow()) W.busyCloses++; });
        ws.addEventListener('error', () => { W.errors++; });
        return ws;
      };
      window.WebSocket.prototype = Native.prototype;
      for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) window.WebSocket[k] = Native[k];
    }, { cell });
    const page = await ctx.newPage();
    const c = { tag, ctx, page, faults: [], console: fs.createWriteStream(path.join(S, `console-${tag}.log`)) };
    page.on('pageerror', (e) => { c.faults.push(e.message.slice(0, 300)); });
    page.on('crash', () => c.faults.push('page crashed'));
    page.on('console', (m) => { c.console.write(`${((Date.now() - t0) / 1000).toFixed(1)} ${m.type()} ${m.text().slice(0, 400)}\n`); });
    await page.goto(origin + '/?menu');
    c.user = { username: `qa-mp-${tag.toLowerCase()}-${crypto.randomBytes(3).toString('hex')}`, password: crypto.randomBytes(18).toString('hex') };
    const reg = await page.evaluate(async (a) => { const r = await fetch('/api/account/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(a) }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, c.user);
    if (reg.status !== 200) throw new Error(`register ${tag}: ${reg.status} ${JSON.stringify(reg.body)}`);
    const launch = await page.evaluate(async (id) => { const r = await fetch(`/api/openmw/${encodeURIComponent(id)}/launch`, { method: 'POST' }); return { status: r.status, body: await r.json().catch(() => ({})) }; }, id);
    if (launch.status !== 200) throw new Error(`launch ${tag}: ${launch.status} ${JSON.stringify(launch.body)}`);
    c.gwName = launch.body.username;
    log(tag, 'registered', c.user.username, 'native', c.gwName);
    await page.goto(`${origin}/ports/openmw/${encodeURIComponent(id)}/app/join#${new URLSearchParams({ mpticket: launch.body.ticket, mpaccount: launch.body.account, mplocker: launch.body.locker })}`);
    clients.push(c);
  }
  const [A, B] = clients;
  const st = (c) => c.page.evaluate(() => { const s = window.omw?.state ?? {}; const j = (k) => { try { return JSON.parse(s[k]); } catch { return s[k] ?? null; } };
    return { url: location.pathname + location.search, net: s.netstate ?? s.state ?? null, simReady: s.simReady ?? null, selfId: s.selfId ?? null, whereNow: s.whereNow ?? null, worldMode: s.worldMode ?? null, amHost: s.amHost ?? null,
      players: j('players'), puppets: j('puppets'), pose: j('pose'), friends: j('friends'), friendRequests: j('friendRequests'), socialResult: s.socialResult ?? null, joinFriendResult: s.joinFriendResult ?? null,
      lastError: s.lastError ?? null, netfail: s.netfail ?? null, reconnectTotal: s.reconnectTotal ?? null, selfDivergence: s.selfDivergence ?? null, cell: s.cell ?? null,
      jspi: window.StreamFS?.jspi?.() ?? null, ws: window.__mpWs ?? null, trap: window.__omwPumpTrap ?? null, fps: window.__fps ?? null }; }).catch((e) => ({ error: String(e.message).slice(0, 200) }));
  const until = async (what, f, ms) => {
    const end = Date.now() + ms; let last = null, said = 0;
    while (Date.now() < end && Date.now() - t0 < limitS * 1000) {
      last = await f(); if (last?.ok) return last;
      if (Date.now() - said > 30000) { said = Date.now(); log('  waiting:', what, JSON.stringify(last?.show ?? last).slice(0, 300)); }
      await sleep(2000);
    }
    return last ?? { ok: false };
  };
  const joined = (s) => s.net === 'Joined' && s.simReady === '1';
  const both = await until('both joined their worlds', async () => { const a = await st(A), b = await st(B); return { ok: joined(a) && joined(b), show: { a: [a.url, a.net, a.simReady, a.lastError], b: [b.url, b.net, b.simReady, b.lastError] } }; }, 600000);
  check('both joined', both.ok, both.show);
  if (!both.ok) throw new Error('not joined');
  const cmd = (c, s) => c.page.evaluate((s) => window.omw.send(s), s);
  // ---- A's world open to friends, A and B friends, B into A's world
  await cmd(A, 'where:party');
  await sleep(3000);
  await cmd(A, `social:FriendRequest:${B.gwName}`);
  const req = await until('B gets A\'s friend request', async () => { const b = await st(B); const r = (b.friendRequests ?? []).find?.(() => true); return { ok: !!r, r, show: [b.friendRequests, b.socialResult] }; }, 120000);
  check('friend request received', req.ok, req.show);
  await cmd(B, `social:FriendAccept:${req.r?.acct ?? A.gwName}`);
  const fr = await until('B sees A as a friend', async () => { const b = await st(B); const f = (b.friends ?? []).find?.(() => true); return { ok: !!f, f, show: [b.friends, b.socialResult] }; }, 120000);
  check('friends', fr.ok, fr.show);
  await cmd(B, `joinfriend:${fr.f?.acct}`);
  const together = await until('B in A\'s world', async () => {
    const a = await st(A), b = await st(B);
    const aSeesB = (a.players ?? []).some?.((p) => p.id !== undefined && String(p.id) !== String(a.selfId)), bSeesA = (b.players ?? []).some?.((p) => String(p.id) !== String(b.selfId));
    const aPup = Object.keys(a.puppets ?? {}).length > 0, bPup = Object.keys(b.puppets ?? {}).length > 0;
    return { ok: joined(a) && joined(b) && aSeesB && bSeesA && aPup && bPup, show: { a: [a.net, a.simReady, a.players, Object.keys(a.puppets ?? {})], b: [b.url, b.net, b.simReady, b.players, Object.keys(b.puppets ?? {}), b.joinFriendResult, b.lastError] } };
  }, 600000);
  check('together, each in the other\'s roster with a puppet', together.ok, together.show);
  if (!together.ok) throw new Error('not together');
  await sleep(10000);
  // ---- A walks, B sees A's puppet move; then B walks, A sees
  // (a move: the mover's player carried 300 units by the engine's debug teleport — run at its next frame's start, the
  // position then sent as any move —; the watcher's puppet of it must follow and end where the mover stands: a desync
  // or a lost update shows as a gap. Three moves each way, the last one back.)
  const move = async (mover, watcher, dx, dy) => {
    const self0 = (await st(mover)).pose, w0 = await st(watcher);
    const id0 = Object.keys(w0.puppets ?? {})[0], p0 = id0 ? w0.puppets[id0] : null;
    const to = [self0.x + dx, self0.y + dy, self0.z + 20];
    await mover.page.evaluate((t) => window.Module._omw_debug_teleport(t[0], t[1], t[2]), to);
    const r = await until('the watcher\'s puppet follows', async () => {
      const m = await st(mover), w = await st(watcher), p = id0 ? w.puppets?.[id0] : null;
      const gap = p && m.pose ? Math.hypot(p.x - m.pose.x, p.y - m.pose.y) : null, there = m.pose ? Math.hypot(m.pose.x - to[0], m.pose.y - to[1]) : null;
      return { ok: gap !== null && gap < 48 && there !== null && there < 48, gap: gap === null ? null : Math.round(gap), there: there === null ? null : Math.round(there),
        moved: p && p0 ? Math.round(Math.hypot(p.x - p0.x, p.y - p0.y)) : null, show: { gap, there, pose: m.pose, puppet: p } };
    }, 90000);
    return { ok: r.ok, moved: r.moved, gapEnd: r.gap, moverOff: r.there, s: Math.round((Date.now() - t0) / 1000) };
  };
  for (const [mover, watcher] of [[A, B], [B, A]]) {
    const runs = [];
    for (const [dx, dy] of [[300, 0], [0, 300], [-300, -300]]) runs.push(await move(mover, watcher, dx, dy));
    check(`${mover.tag} moves 3 times, ${watcher.tag}'s copy follows to its place`, runs.every((r) => r.ok && r.moved > 200), runs);
  }
  // (both carried to another cell, one after the other — cell loads whose reads suspend the frames (JSPI) while the
  // world's messages arrive —; each must then see the other's copy where the other stands)
  {
    const a0 = (await st(A)).pose, far = [a0.x + 8192 + 600, a0.y + 600, a0.z + 400];
    await A.page.evaluate((t) => window.Module._omw_debug_teleport(t[0], t[1], t[2]), far);
    await sleep(5000);
    await B.page.evaluate((t) => window.Module._omw_debug_teleport(t[0] + 150, t[1], t[2]), far);
    const r = await until('both in the other cell, each copy where the other stands', async () => {
      const a = await st(A), b = await st(B);
      const pa = Object.values(b.puppets ?? {})[0], pb = Object.values(a.puppets ?? {})[0];
      const ga = pa && a.pose ? Math.hypot(pa.x - a.pose.x, pa.y - a.pose.y) : null, gb = pb && b.pose ? Math.hypot(pb.x - b.pose.x, pb.y - b.pose.y) : null;
      const there = a.pose && b.pose ? Math.hypot(a.pose.x - far[0], a.pose.y - far[1]) < 400 && Math.hypot(b.pose.x - far[0] - 150, b.pose.y - far[1]) < 400 : false;
      return { ok: there && ga !== null && ga < 48 && gb !== null && gb < 48 && joined(a) && joined(b), ga, gb, show: { a: [a.net, a.cell, a.pose], b: [b.net, b.cell, b.pose], ga, gb } };
    }, 180000);
    check('both in another cell, each copy where the other stands', r.ok, r.show);
  }
  // (and a walk, W held, as a player would: reported, not required — headless SwiftShader at a few frames a second)
  for (const [mover, watcher] of [[A, B]]) {
    const p0 = Object.values((await st(watcher)).puppets ?? {})[0], s0 = (await st(mover)).pose;
    await mover.page.bringToFront().catch(() => {});
    await mover.page.mouse.click(400, 300).catch(() => {});
    await mover.page.keyboard.down('w'); await sleep(8000); await mover.page.keyboard.up('w'); await sleep(8000);
    const p1 = Object.values((await st(watcher)).puppets ?? {})[0], s1 = (await st(mover)).pose;
    result[`walk${mover.tag}`] = { self: s0 && s1 ? Math.round(Math.hypot(s1.x - s0.x, s1.y - s0.y)) : null, puppet: p0 && p1 ? Math.round(Math.hypot(p1.x - p0.x, p1.y - p0.y)) : null, gapEnd: p1 && s1 ? Math.round(Math.hypot(p1.x - s1.x, p1.y - s1.y)) : null };
    log('walk', mover.tag, JSON.stringify(result[`walk${mover.tag}`]));
  }
  await sleep(20000);
  const a = await st(A), b = await st(B);
  check('still joined, no error', joined(a) && joined(b) && !a.trap && !b.trap, { a: [a.net, a.lastError, a.netfail, a.reconnectTotal], b: [b.net, b.lastError, b.netfail, b.reconnectTotal] });
  result.pages = { A: { ...a, faults: A.faults }, B: { ...b, faults: B.faults } };
  check('no page error', !A.faults.length && !B.faults.length, { A: A.faults, B: B.faults });
  // (the pictures: each client's tour closed — its onboarding panel holds the UI mode, the inventory shown —, B carried
  // 160 units from A, each camera turned to the other's copy — OpenMW's yaw: 0 north (+y), 90 east (+x) —, frames left
  // to draw, then the shot; the copies' positions at that moment kept beside it)
  for (const c of clients) for (let i = 0; i < 6; i++) { const open = await c.page.evaluate(() => document.getElementById('omw-tour')?.classList.contains('show')).catch(() => false); if (!open) break; await c.page.click('#omw-tour-x').catch(() => {}); await sleep(1000); }
  { const a0 = (await st(A)).pose; await B.page.evaluate((t) => window.Module._omw_debug_teleport(t[0], t[1] + 160, t[2] + 20), [a0.x, a0.y, a0.z]); }
  await sleep(8000);
  result.shots = {};
  for (const [me, other] of [[A, B], [B, A]]) {
    const m = await st(me), o = await st(other), pup = Object.values(m.puppets ?? {})[0];
    if (!m.pose || !pup) continue;
    const yaw = Math.atan2(pup.x - m.pose.x, pup.y - m.pose.y) * 180 / Math.PI;
    await me.page.evaluate((y) => window.Module._omw_debug_look(y, 5), yaw);
    result.shots[me.tag] = { yaw: Math.round(yaw), self: m.pose, copyOfOther: pup, otherSelf: o.pose, gap: o.pose ? Math.round(Math.hypot(pup.x - o.pose.x, pup.y - o.pose.y)) : null, tourOpen: await me.page.evaluate(() => document.getElementById('omw-tour')?.classList.contains('show')).catch(() => null) };
  }
  await sleep(10000);
  for (const c of clients) await c.page.screenshot({ path: path.join(S, `shot-${c.tag}.png`) }).catch(() => {});
  log('shots', JSON.stringify(result.shots));
} catch (e) {
  result.error = String(e.stack ?? e).slice(0, 2000); log('ERROR', result.error);
} finally {
  result.ok = !result.error && Object.values(result.checks).every((c) => c.ok);
  result.seconds = Math.round((Date.now() - t0) / 1000);
  fs.writeFileSync(path.join(S, 'result.json'), JSON.stringify(result, null, 1));
  if (browser) await browser.close().catch(() => {});
  for (const k of kids.reverse()) { if (k.exitCode === null) { k.kill('SIGTERM'); await new Promise((r) => { k.once('exit', r); setTimeout(r, 15000); }); } }
  if (games) clearScratchGames(games.out);
  log('RESULT', JSON.stringify({ ok: result.ok, checks: Object.fromEntries(Object.entries(result.checks).map(([k, v]) => [k, v.ok])) }));
}
