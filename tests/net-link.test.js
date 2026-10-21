// The player's connection model (src/vfs/net-link.js): bandwidth measured from the transfers, the game's reads first,
// background turns by priority, request sizes from the measure; and the page's wording of a wait (net-status.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetLink, FAST_BPS, BG_SECONDS } from '../src/vfs/net-link.js';
import { netWaitText, fmtRate, fmtDuration, benchNetwork } from '../src/host/web/net-status.js';
import { downloadStatus } from '../src/host/web/download.js';

/** a fake clock: timers fire when the test advances the time */
function clock() {
  let now = 0; const timers = [];
  return {
    now: () => now,
    setTimer: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    advance(ms) { const end = now + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const t = timers[0]; if (!t || t.at > end) break; timers.shift(); now = t.at; t.fn(); } now = end; },
  };
}
const flush = () => new Promise((r) => setImmediate(r));

test('net link: the rate is measured from what crossed the link over its busy time, less the round trips', () => {
  const c = clock(), n = new NetLink(c);
  assert.equal(n.bw, null); assert.ok(!n.fast(), 'not measured: careful (small requests, one at a time)');
  assert.equal(n.maxBackground(), 2); assert.equal(n.backgroundBytes(), 256 << 10); assert.ok(!n.thin());
  assert.ok(new NetLink({ fixed: true }).fast(), 'never measured (tests, tools): the local-network policies');
  // 85 KB/s with a 50 ms round trip: a small answer (times the round trip), then 64 KiB requests one after the other
  const s = n.begin('demand', 2048); c.advance(50 + 2048 / 85); n.end(s, 2048, 2048); c.advance(20);
  for (let i = 0; i < 12; i++) {
    const t = n.begin('demand', 65536);
    c.advance(50 + 65536 / 85);
    n.end(t, 65536, 65536);
    c.advance(20); // (the game works a little between two reads)
  }
  assert.ok(n.measured);
  assert.ok(Math.abs(n.bw - 85000) / 85000 < 0.15, `measured ${Math.round(n.bw)} B/s`);
  assert.ok(!n.fast());
  assert.ok(n.rtt >= 50 && n.rtt < 900);
  // sizes from the measure: the background requests in flight carry about BG_SECONDS of the link together (at least
  // one request of 64 KiB)
  assert.equal(n.backgroundBytes(), 64 << 10);
  const b1 = n.begin('bg', 65536);
  assert.equal(n.mayStart(0, false, 65536), false, 'a second 64 KiB request would hold the game up twice as long');
  n.end(b1, 65536);
  const c3 = clock(), m3 = new NetLink({ ...c3, bw: 2.5e6 });
  for (let i = 0; i < 8; i++) { assert.ok(m3.tryTurn(0, {}, 20000), `small request ${i} (a run of small files fills the link)`); m3.begin('bg', 20000); }
  assert.equal(m3.tryTurn(0, {}, 20000), false, 'at most maxBackground() at once');
  assert.ok(n.demandExtra(1 << 20) <= 85000 * 0.3);
  // two transfers at once share the link: the busy time counts once
  const c2 = clock(), m = new NetLink(c2);
  for (let i = 0; i < 6; i++) {
    const a = m.begin('bg', 1 << 20), b = m.begin('demand', 1 << 20);
    c2.advance(2 * (1 << 20) / 5000); // (5 MB/s, both)
    m.end(a, 1 << 20); m.end(b, 1 << 20);
  }
  assert.ok(Math.abs(m.bw - 5e6) / 5e6 < 0.25, `measured ${Math.round(m.bw)} B/s`);
  assert.ok(m.backgroundBytes() >= 1 << 20 && m.backgroundBytes() <= Math.ceil(5e6 * BG_SECONDS));
});

test('net link: the round trip from the first byte of any answer; large answers alone then measure the rate', () => {
  const c = clock(), n = new NetLink(c);
  for (let i = 0; i < 8; i++) {
    const t = n.begin('demand', 262144);
    c.advance(50); n.firstByte(t); // (headers after the round trip)
    c.advance(262144 / 1000); n.end(t, 262144, 262144); // (1 MB/s)
  }
  assert.equal(n.rtt, 50);
  assert.ok(Math.abs(n.bw - 1e6) / 1e6 < 0.1, `measured ${Math.round(n.bw)} B/s`);
});

test('net link: compressed answers — sizes are in file bytes, the rate in wire bytes', () => {
  const c = clock(), n = new NetLink(c);
  for (let i = 0; i < 10; i++) { const t = n.begin('demand', 262144); c.advance(1000); n.end(t, 100000, 262144); }
  assert.ok(Math.abs(n.bw - 100000) / 100000 < 0.1);
  assert.ok(n.ratio() > 0.35 && n.ratio() < 0.42);
  assert.ok(n.secondsFor(262144) > 0.9 && n.secondsFor(262144) < 1.1, 'a file range the size of one answer takes as long as one answer');
});

test('net link: background turns wait for the game\'s reads, in priority order, one at a time on a thin link', async () => {
  const c = clock(), n = new NetLink({ ...c, bw: 85000 });
  const order = [];
  const d = n.begin('demand', 65536);
  const p3 = n.turn(3, 150, () => false, {}, 65536).then((ok) => order.push(['fill', ok]));
  const p1 = n.turn(1, 0, () => false, {}, 65536).then((ok) => order.push(['readAhead', ok]));
  await flush();
  assert.deepEqual(order, [], 'nothing starts while the game reads');
  c.advance(800); n.end(d, 65536); await flush();
  assert.deepEqual(order, [['readAhead', true]], 'the higher priority first, at once (no quiet time asked)');
  const t1 = n.begin('bg', 65536);
  c.advance(300); await flush();
  assert.equal(order.length, 1, 'one background request at a time on a thin link');
  n.end(t1, 65536); c.advance(200); await flush();
  assert.deepEqual(order.map((o) => o[0]), ['readAhead', 'fill']);
  await Promise.all([p1, p3]);
  // a waiting download the game now waits for goes at once, before the others
  n.begin('demand', 1000);
  const w = {}, got = [];
  n.turn(5, 300).then(() => got.push('prefetch'));
  n.turn(2, 0, () => false, w).then(() => got.push('ahead'));
  await flush(); assert.deepEqual(got, []);
  n.promote(w); await flush();
  assert.deepEqual(got, ['ahead']);
  // a stopped session's waiting downloads end (false)
  let stopped = false; const r = n.turn(7, 500, () => stopped);
  stopped = true; c.advance(300); assert.equal(await r, false);
});

test('net link: a fast link keeps the local-network policies (no quiet time, several background requests)', async () => {
  const c = clock(), n = new NetLink({ ...c, bw: 200e6 });
  assert.ok(n.fast() && n.bw >= FAST_BPS);
  n.begin('demand', 1 << 20);
  assert.equal(n.tryTurn(0), true, 'no wait for the game\'s reads');
  assert.equal(n.maxBackground(), 64, "as before: no real cap");
  assert.equal(n.backgroundBytes(), 4 << 20);
});

test('net link: between thin and fast, background requests go beside the game\'s reads within the link\'s bytes', () => {
  const c = clock(), n = new NetLink({ ...c, bw: 1e6 });
  assert.ok(!n.fast() && !n.thin());
  const budget = n.backgroundBytes();
  assert.ok(budget >= 256 << 10 && budget <= 512 << 10, `${budget}`);
  n.begin('demand', 65536);
  assert.ok(n.mayStart(300, false, 65536), 'a small one beside a game read, no quiet time');
  assert.ok(!n.mayStart(0, false, budget), 'not one that would hold the game read up longer than the budget');
  const thin = new NetLink({ ...c, bw: 85000 });
  thin.begin('demand', 65536);
  assert.ok(!thin.mayStart(0, false, 1024), 'a thin link: the game\'s read alone');
});

test('net link: only the background requests that would hold the game up long are aborted', () => {
  const c = clock(), n = new NetLink({ ...c, bw: 100000 });
  let aborted = [];
  n.begin('bg', 1 << 20, () => aborted.push('big')); // (sized before the link was measured: ~10 s)
  n.begin('bg', 32768, () => aborted.push('small'));
  c.advance(100);
  n.abortLong();
  assert.deepEqual(aborted, ['big']);
});

test('net status: the waiting message names the rate, what came and the step\'s time', () => {
  assert.equal(netWaitText(null), null);
  assert.equal(netWaitText({ waiting: false, bw: 1 }), null);
  const t = netWaitText({ waiting: true, bw: 87040, demandBytes: 10 << 20, bgBytes: 4 << 20, stepWire: 87040 * 240 });
  assert.match(t.title, /^Downloading game data — 85 KB\/s$/);
  assert.match(t.detail, /14 MB received/);
  assert.match(t.detail, /about 4 min for this step/);
  assert.match(t.detail, /download the whole game first/);
  assert.equal(fmtRate(5 * 1048576), '5.0 MB/s');
  assert.equal(fmtDuration(7300), 'about 2 h 2 min');
  assert.equal(fmtDuration(42, 'fr', true), '~40 s');
  assert.deepEqual(Object.keys(benchNetwork({ bw: 5, demandBytes: 1 })).sort(), ['aborted', 'bgBytes', 'bgRequests', 'bw', 'demandBytes', 'demandMs', 'demandRequests', 'measured', 'rtt']);
});

test('download first: the home screen line from the kept progress', () => {
  assert.equal(downloadStatus(null, 1.5e9, 'en').state, 'none');
  const p = downloadStatus({ bytes: 0.5e9, total: 1.5e9, bw: 85000, ratio: 0.7 }, 1.5e9, 'en');
  assert.equal(p.state, 'paused'); assert.equal(p.pct, 33);
  assert.equal(p.text, '33% downloaded · ~2 h 17 min more');
  assert.match(p.detail, /33% downloaded .* more at 83 KB\/s/);
  assert.ok(Math.abs(p.eta - 1e9 * 0.7 / 85000) < 1);
  assert.equal(downloadStatus({ bytes: 1.5e9, total: 1.5e9, done: true }, 1.5e9, 'fr').state, 'done');
  assert.match(downloadStatus({ running: true, bytes: 1e8, total: 1e9, bw: 1e6 }, 1e9, 'fr').text, /restantes/);
});

/**
 * A link of `rate` bytes/s shared equally by the answers on it (as the harness's SimLink: a 50 ms round trip, then the
 * bytes), `pattern(now, active, start)` starting requests; the estimates after the first 20 s.
 */
function shared(rate, pattern, seconds = 120) {
  let now = 0; const n = new NetLink({ now: () => now, setTimer: () => 0, clearTimer: () => {} });
  const active = [], seen = [];
  const start = (kind, bytes) => active.push({ tok: n.begin(kind, bytes), left: bytes, bytes, wait: 50 });
  while (now < seconds * 1000) {
    pattern(now, active, start);
    const flowing = active.filter((a) => a.wait <= 0);
    for (const a of active) if (a.wait > 0 && (a.wait -= 10) <= 0) n.firstByte(a.tok);
    for (const a of flowing) a.left -= rate * 0.01 / flowing.length;
    now += 10;
    for (const a of [...active]) if (a.left <= 0) { active.splice(active.indexOf(a), 1); n.end(a.tok, a.bytes, a.bytes); }
    if (now > 20000 && now % 1000 === 0 && n.bw) seen.push(n.bw);
  }
  return { min: Math.min(...seen), max: Math.max(...seen) };
}

test('net link: answers sharing the link, a long one beside small ones — the rate is not read several times too low', () => {
  for (const rate of [85000, 1e6]) {
    // three answers of different sizes always on the link (a long one's time no longer counts without its bytes)
    const a = shared(rate, (now, active, start) => { while (active.length < 3) start('bg', 65536 * (1 + active.length)); });
    assert.ok(a.min > rate * 0.85 && a.max < rate * 1.15, `${rate} B/s, three at once: measured ${Math.round(a.min)}-${Math.round(a.max)}`);
    // a game read of 1 MiB every 20 s, small background answers one after the other beside it
    const b = shared(rate, (now, active, start) => { if (now % 20000 === 0) start('demand', 1 << 20); if (!active.some((x) => x.tok.kind === 'bg')) start('bg', 65536); });
    assert.ok(b.min > rate * 0.75 && b.max < rate * 1.15, `${rate} B/s, long and small: measured ${Math.round(b.min)}-${Math.round(b.max)}`);
  }
});
