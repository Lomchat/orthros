#!/usr/bin/env node
// A first visit of the home (and of the port pages) on a given link: a fresh browser profile, the link throttled by
// Chrome itself (CDP), then the times a player sees — first paint, the library drawn (the first real card), every cover
// in view shown, the network quiet — and what crossed the link (bytes, requests, the covers apart). Run it through
// tools/with-browser-slot.sh (one browser, a few seconds).
//
//   tools/with-browser-slot.sh node tools/home-check.mjs --url http://127.0.0.1:8080 [--kbps 85] [--rtt 80] [--runs 3]
//        [--pages /,/ports/re3/vice-city-revc/] [--json]
// --kbps 0: no throttling. Prints the median of --runs fresh visits per page.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const base = arg('--url', 'http://127.0.0.1:8080').replace(/\/$/, '');
const kbps = Number(arg('--kbps', 85)), rtt = Number(arg('--rtt', 80)), runs = Number(arg('--runs', 3));
const pages = arg('--pages', '/').split(',');
const limitMs = Number(arg('--timeout', 60000));

const browser = await chromium.launch({ args: ['--enable-features=SharedArrayBuffer'] });
const results = {};
try {
  for (const page of pages) {
    const all = [];
    for (let r = 0; r < runs; r++) {
      const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1.25 });
      const p = await ctx.newPage();
      const cdp = await ctx.newCDPSession(p);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
      if (kbps > 0) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: rtt, downloadThroughput: kbps * 1000, uploadThroughput: kbps * 1000 });
      const reqs = new Map(); let bytes = 0, covers = 0, coverBytes = 0, lastEnd = 0;
      const t0 = Date.now();
      cdp.on('Network.requestWillBeSent', (e) => reqs.set(e.requestId, e.request.url));
      cdp.on('Network.loadingFinished', (e) => {
        bytes += e.encodedDataLength; lastEnd = Date.now() - t0;
        if (/\/api\/cover\//.test(reqs.get(e.requestId) ?? '')) { covers++; coverBytes += e.encodedDataLength; }
      });
      await p.addInitScript(() => {
        window.__paint = {};
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__paint[e.name] = e.startTime; }).observe({ type: 'paint', buffered: true });
      });
      await p.goto(base + page, { waitUntil: 'commit' });
      const isHome = page === '/' || page.startsWith('/?');
      let drawn = null, coversShown = null;
      if (isHome) {
        await p.waitForSelector('#menu .hm-card:not(.skeleton) h3', { timeout: limitMs }).catch(() => {});
        drawn = await p.evaluate(() => performance.now());
        // (every cover in view shown: the cards' images in the viewport loaded)
        await p.waitForFunction(() => {
          const imgs = [...document.querySelectorAll('#menu .hm-cover img')].filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && !i.classList.contains('glyph'); });
          return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0 && i.classList.contains('loaded'));
        }, null, { timeout: limitMs, polling: 100 }).catch(() => {});
        coversShown = await p.evaluate(() => performance.now());
      }
      // (quiet: nothing finished for 2 s)
      for (let quiet = 0; quiet < 2000;) { const before = lastEnd; await p.waitForTimeout(250); quiet = lastEnd === before ? quiet + 250 : 0; if (Date.now() - t0 > limitMs) break; }
      const paint = await p.evaluate(() => window.__paint);
      all.push({ fcp: paint['first-contentful-paint'] ?? null, drawn, coversShown, quietMs: lastEnd, KB: bytes / 1024, requests: reqs.size, covers, coverKB: coverBytes / 1024 });
      await ctx.close();
    }
    const med = (k) => { const a = all.map((x) => x[k]).filter((x) => x !== null).sort((x, y) => x - y); return a.length ? +a[a.length >> 1].toFixed(k.endsWith('KB') ? 1 : 0) : null; };
    results[page] = Object.fromEntries(Object.keys(all[0]).map((k) => [k, med(k)]));
  }
} finally { await browser.close(); }
if (args.includes('--json')) console.log(JSON.stringify({ kbps, rtt, runs, results }));
else for (const [pg, r] of Object.entries(results)) console.log(`${pg} @ ${kbps ? kbps + ' KB/s' : 'unthrottled'}, ${rtt} ms (median of ${runs}): first paint ${r.fcp} ms, library drawn ${r.drawn ?? '-'} ms, covers in view ${r.coversShown ?? '-'} ms, quiet at ${r.quietMs} ms; ${r.KB} KiB in ${r.requests} requests (covers ${r.covers}, ${r.coverKB} KiB)`);
