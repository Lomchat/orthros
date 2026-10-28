#!/usr/bin/env node
// A first visit of the home (and of the port pages) on a given link: a fresh browser profile, the link throttled by
// Chrome itself (CDP), then the times a player sees — first paint, the library drawn (the first real card), every cover
// in view shown, the network quiet — and what crossed the link (bytes, requests, the covers apart). Run it through
// tools/with-browser-slot.sh (one browser, a few seconds).
//
//   tools/with-browser-slot.sh node tools/home-check.mjs --url http://127.0.0.1:8080 [--kbps 85] [--rtt 80] [--runs 3]
//        [--pages /,/ports/re3/vice-city-revc/] [--warm] [--json]
// --kbps 0: no bandwidth limit (--rtt still applies; --rtt 0 too: no throttling). Prints the median of --runs visits per page.
// --warm: a returning player's visit — the page loaded once unmeasured in the same profile, then again, measured: its
// modules revalidated (no-cache: a 304 each, server.js sendSource), the chain of import levels a round trip each.
// A modulepreload trial (all of the graph asked at once instead of a level a round trip): a second server run from a
// copy of the tree whose page carries the tags (tools/page-weight.mjs --preload-html) — not page.route, which turns
// the browser's cache off (no 304 left to measure).
// Besides the paint times: config (when /api/config was asked — the library's data, after the whole graph ran), the
// /src/ requests and how many of them were 304s.
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const base = arg('--url', 'http://127.0.0.1:8080').replace(/\/$/, '');
const kbps = Number(arg('--kbps', 85)), rtt = Number(arg('--rtt', 80)), runs = Number(arg('--runs', 3));
const pages = arg('--pages', '/').split(',');
const limitMs = Number(arg('--timeout', 60000));
const warm = args.includes('--warm');

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
      // (-1: no bandwidth limit, the round trip alone)
      if (kbps > 0 || rtt > 0) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: rtt, downloadThroughput: kbps > 0 ? kbps * 1000 : -1, uploadThroughput: kbps > 0 ? kbps * 1000 : -1 });
      await p.addInitScript(() => {
        window.__paint = {};
        new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__paint[e.name] = e.startTime; }).observe({ type: 'paint', buffered: true });
      });
      // (--warm: the first visit fills the profile's cache, unmeasured; the network quiet before the measured one)
      if (warm) {
        await p.goto(base + page, { waitUntil: 'load', timeout: limitMs });
        await p.waitForTimeout(2000);
      }
      const reqs = new Map(); let bytes = 0, covers = 0, coverBytes = 0, lastEnd = 0, srcRequests = 0, src304 = 0, docTs = null, configTs = null;
      const t0 = Date.now();
      cdp.on('Network.requestWillBeSent', (e) => {
        reqs.set(e.requestId, e.request.url);
        const u = new URL(e.request.url);
        if (docTs === null && e.type === 'Document') docTs = e.timestamp;
        if (configTs === null && u.pathname === '/api/config') configTs = e.timestamp;
        if (u.pathname.startsWith('/src/')) srcRequests++;
      });
      cdp.on('Network.responseReceived', (e) => { if (e.response.status === 304 && new URL(e.response.url).pathname.startsWith('/src/')) src304++; });
      cdp.on('Network.loadingFinished', (e) => {
        bytes += e.encodedDataLength; lastEnd = Date.now() - t0;
        if (/\/api\/cover\//.test(reqs.get(e.requestId) ?? '')) { covers++; coverBytes += e.encodedDataLength; }
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
      // (config: from the page's request to /api/config's, the CDP clock — the same one for both)
      const config = docTs !== null && configTs !== null ? (configTs - docTs) * 1000 : null;
      all.push({ fcp: paint['first-contentful-paint'] ?? null, config, drawn, coversShown, quietMs: lastEnd, KB: bytes / 1024, requests: reqs.size, src: srcRequests, src304, covers, coverKB: coverBytes / 1024 });
      await ctx.close();
    }
    const med = (k) => { const a = all.map((x) => x[k]).filter((x) => x !== null).sort((x, y) => x - y); return a.length ? +a[a.length >> 1].toFixed(k.endsWith('KB') ? 1 : 0) : null; };
    results[page] = Object.fromEntries(Object.keys(all[0]).map((k) => [k, med(k)]));
  }
} finally { await browser.close(); }
if (args.includes('--json')) console.log(JSON.stringify({ kbps, rtt, runs, warm, results }));
else for (const [pg, r] of Object.entries(results)) console.log(`${pg} @ ${kbps ? kbps + ' KB/s' : 'no bandwidth limit'}, ${rtt} ms${warm ? ', warm' : ''} (median of ${runs}): first paint ${r.fcp} ms, /api/config asked at ${r.config ?? '-'} ms, library drawn ${r.drawn ?? '-'} ms, covers in view ${r.coversShown ?? '-'} ms, quiet at ${r.quietMs} ms; ${r.KB} KiB in ${r.requests} requests (/src/ ${r.src}, ${r.src304} of them 304; covers ${r.covers}, ${r.coverKB} KiB)`);
