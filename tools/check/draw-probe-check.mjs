// Checks the draw probe end to end in headless Chromium (src/gfx/draw-probe.js): a Direct3D 9 device (tests/d3d-env.js)
// drawn by the real WebGL backend — on the page's thread, or recorded and replayed through the command ring as a render
// worker does (render-host.js createInlineGfx: the game's TEXTUREFACTOR then comes through the ring's stamps) — draws a
// pause screen like the owner's RotWK one: a scene, a few UI quads, a black veil of alpha TEXTUREFACTOR 0xcc (stage
// MODULATE DIFFUSE x TFACTOR, SRCALPHA blending), an additive disc whose colour moves every frame, a last quad. Nobody
// asks for the probe: the flicker probe's samples (a clock that runs fast until it starts) see a still screen or a
// flicker and start it. Faults made on purpose, one frame in three:
// - gl: the veil drawn with alpha x 0.3 by GL while the game, the mirror and the backend's cache all say 0xcc
//   (dbg ORTHROS_FAKE_TF=3: d3d8-webgl.js fakeTfDraw) — the reader must say "what GL makes of the same commands and values";
// - game: the game sets TEXTUREFACTOR 0x28 — the reader must name the game's own value;
// - none: nothing varies — the probe tries, finds nothing and sends nothing;
// - runs (2026-11-18): the GL fault in runs of 3 frames out of 6 (ORTHROS_FAKE_TF=-3) under commands that change every
//   frame — the owner's AotR pause — the alternation sample must start the probe (src/shared/draw-probe.js alternation);
// - report: the same, the player's display report asked before any sample — the probe runs in its window (trigger
//   `report`), its record printed by tools/dev/flicker-report.mjs with the report.
// Each record is written as a telemetry line and read by tools/dev/draw-probe.mjs; also printed: the frame time without
// and with the probe recording (the page's CPU time per frame, SwiftShader).
// Usage: tools/with-browser-slot.sh node tools/check/draw-probe-check.mjs [--out <dir>] (default
// /tmp/orthros-scratch/draw-probe-check: the records, the reader's output and pictures)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = new URL('../..', import.meta.url).pathname;
const args = process.argv.slice(2), out = args.includes('--out') ? args[args.indexOf('--out') + 1] : '/tmp/orthros-scratch/draw-probe-check';
fs.mkdirSync(out, { recursive: true });
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-angle=swiftshader', '--enable-webgl'] });
const telemetry = path.join(out, 'telemetry.jsonl');
fs.writeFileSync(telemetry, '');
try {
  const page = await browser.newPage();
  await page.route('http://localhost:9/**', (r) => {
    const u = new URL(r.request().url()).pathname, file = path.join(root, u);
    if (u === '/') return r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>draw probe</title>' });
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return r.fulfill({ status: 404 });
    r.fulfill({ body: fs.readFileSync(file), contentType: u.endsWith('.json') ? 'application/json' : 'text/javascript' });
  });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:9/');
  const run = (sc) => page.evaluate(async (sc) => {
    const { createWebGLBackend } = await import('/src/gfx/d3d8-webgl.js');
    const { createInlineGfx } = await import('/src/gfx/render-host.js');
    const { d3dEnv } = await import('/tests/d3d-env.js');
    const W = 640, H = 480, recs = [], logs = [];
    const bb = [];
    const log = (m) => { if (m && typeof m === 'object') { if (m.event === 'draw-probe') recs.push(m); else if (m.event === 'display-report-bb' && !m.started) bb.push(m); } else logs.push(String(m)); };
    const canvas = new OffscreenCanvas(W, H);
    const gfx = sc.path === 'inline' ? createInlineGfx(canvas, log, null) : createWebGLBackend(canvas, log, null);
    globalThis.ORTHROS_FAKE_TF = sc.fault === 'gl' ? 3 : sc.fault === 'runs' ? -3 : undefined;
    const { mem, ctx, com, defs, alloc } = d3dEnv(gfx);
    const pp = alloc(64), out = alloc(16), vb = alloc(4096);
    [W, H, 22, 1, 0, 0, 1, 0, 0, 1, 75, 0, 0, 0].forEach((v, i) => mem.write32(pp + 4 * i, v));
    const d3dPtr = defs.Direct3DCreate9[1](ctx([32])), d3d = com.implAt(d3dPtr);
    if (d3d.CreateDevice(ctx([d3dPtr, 0, 1, 0, 0x40, pp, out])) !== 0) return { error: 'CreateDevice failed' };
    const devPtr = mem.read32(out), dev = com.implAt(devPtr);
    const call = (name, ...a) => dev[name](ctx([devPtr, ...a]));
    let vo = 0;
    /** a quad (XYZRHW | DIFFUSE, a triangle strip) with its corner colours */
    const quad = (x0, y0, x1, y1, c) => {
      const a = vb + vo; vo = (vo + 80) % 4000;
      [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].forEach(([x, y], i) => { const p = a + 20 * i; mem.writeF32(p, x); mem.writeF32(p + 4, y); mem.writeF32(p + 8, 0.5); mem.writeF32(p + 12, 1); mem.write32(p + 16, (Array.isArray(c) ? c[i] : c) >>> 0); });
      call('DrawPrimitiveUP', 5, 2, a, 20);
    };
    const RS = (k, v) => call('SetRenderState', k, v >>> 0), TSS = (k, v) => call('SetTextureStageState', 0, k, v);
    call('SetFVF', 0x44); RS(7, 0); RS(22, 1); RS(137, 0);
    let frame = 0, t = 0, fp = null, asked = false;
    const times = { idle: [], rec: [] };
    const step = () => {
      const t0 = performance.now();
      call('BeginScene'); call('Clear', 0, 0, 1, 0xff304050, 0x3f800000, 0);
      // (the scene and the UI: opaque; with sc.vary, commands that change every frame — a depth function, depth off —
      // as the owner's AotR pause of 2026-11-18, whose command signature changed every frame along a 45-frame cycle)
      TSS(1, 2); TSS(2, 0); TSS(4, 2); TSS(5, 0); RS(27, 0); if (sc.vary) RS(23, 1 + (frame % 7));
      if (sc.report === frame || (sc.report === 'busy' && fp?.dp?.phase === 'record' && !asked)) { globalThis.ORTHROS_FLICKER_REPORT = 1; asked = true; } // (the player's button: src/web/main.js reportDisplay; busy: while the session's own probe records)
      quad(0, 0, W / 2, H, [0xffc08040, 0xff80c060, 0xff4080c0, 0xffc0c0c0]); quad(W / 2, 0, W, H, [0xff80c060, 0xffe0a060, 0xffc0c0c0, 0xff60a0e0]);
      for (let i = 0; i < 4; i++) quad(260, 120 + 50 * i, 380, 160 + 50 * i, 0xff4070a0);
      // (the veil: black, alpha = vertex alpha x TEXTUREFACTOR, SRCALPHA / INVSRCALPHA)
      TSS(4, 4); TSS(5, 0); TSS(6, 3); RS(27, 1); RS(19, 5); RS(20, 6);
      RS(60, sc.fault === 'game' && frame % 3 === 0 ? 0x28000000 : 0xcc000000);
      quad(0, 0, W, H, 0xff000000);
      // (the disc: additive, its colour moving a little every frame — a texture animation's stand-in)
      TSS(4, 2); TSS(5, 0); RS(19, 2); RS(20, 2);
      const b = 0x30 + Math.round(8 * Math.sin(frame / 5));
      quad(220, 140, 420, 340, 0xff000000 | (0x18 << 16) | (0x20 << 8) | b);
      RS(27, 0); quad(280, 400, 360, 430, 0xffe0e0e0);
      call('EndScene'); call('Present', 0, 0, 0, 0);
      gfx.afterSlice?.(); // (the inline path: the recorded frame replayed)
      if (!fp && gfx.device?.probe?.flicker) { fp = gfx.device.probe.flicker; fp.now = () => t; fp.next = t + 10000; } // (the probe's clock: ours)
      (fp?.dp?.phase === 'record' ? times.rec : !fp?.dp ? times.idle : []).push(performance.now() - t0);
      frame++; t += fp?.dp?.active ? 33 : 200;
    };
    for (let k = 0; k < sc.frames; k++) {
      step();
      await new Promise((r) => setTimeout(r, 0)); // (the record is made in slices between frames)
      if ((recs.length >= (sc.report === 'busy' ? 2 : 1) && (sc.report === undefined || bb.length)) || (sc.fault === 'none' && fp?.dpTries >= 1)) break;
    }
    for (let k = 0; k < 40 && fp?.dp && !recs.length; k++) { step(); await new Promise((r) => setTimeout(r, 5)); }
    const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length * 100) / 100 : null);
    globalThis.ORTHROS_FLICKER_REPORT = undefined;
    return { recs, bb: bb.map((m) => ({ id: m.id, frames: m.strip?.frames?.length ?? 0, notes: m.strip?.notes ?? m.notes ?? [], summary: m.strip?.analysis?.summary ?? null })), logs: logs.filter((l) => /draw probe|flicker|alternation|error/i.test(l)).slice(-10), frames: frame, tries: fp?.dpTries ?? null, sent: fp?.dpSent ?? null, idleMs: mean(times.idle.slice(5)), recMs: mean(times.rec), recFrames: times.rec.length, renderer: gfx.gl?.getParameter(gfx.gl.RENDERER) };
  }, sc);

  // (runs: the veil faint in runs of 3 frames out of 6 — ORTHROS_FAKE_TF=-3 — under commands that change every frame,
  // as the owner's AotR pause of 2026-11-18: neither a still screen nor a same-commands flicker; the alternation sample
  // must start the probe. report: the same, the player's display report asked at frame 20, before any sample: the probe
  // runs in its window, trigger `report`)
  for (const sc of [{ name: 'gl', path: 'thread', fault: 'gl', frames: 400 }, { name: 'gl-ring', path: 'inline', fault: 'gl', frames: 400 }, { name: 'game', path: 'thread', fault: 'game', frames: 400 }, { name: 'none', path: 'thread', fault: 'none', frames: 400 },
    { name: 'runs', path: 'thread', fault: 'runs', vary: true, frames: 400 }, { name: 'report', path: 'thread', fault: 'runs', vary: true, report: 20, frames: 400 },
    { name: 'report-busy', path: 'inline', fault: 'runs', vary: true, report: 'busy', frames: 600 }]) {
    const r = await run(sc);
    console.log(`--- ${sc.name} (${sc.path}, fault ${sc.fault}${sc.vary ? ', commands changing every frame' : ''}${sc.report === 'busy' ? ', display report asked while the session\'s probe records' : sc.report !== undefined ? `, display report at frame ${sc.report}` : ''}): ${r.error ?? `${r.frames} frames, ${r.recs.length} record(s), tries ${r.tries}; page CPU per frame ${r.idleMs} ms idle, ${r.recMs} ms while recording (${r.recFrames} frames)`}`);
    for (const l of r.logs ?? []) console.log(`  [log] ${l}`);
    if (r.error) { check(false, r.error); continue; }
    if (sc.fault === 'none') { check(r.recs.length === 0 && r.tries === 1, 'a still screen where nothing varies: tried once, nothing sent'); continue; }
    // (busy: the report asked while the session's own probe recorded — it waits for that one's end, then its own probe
    // records in its window: two records)
    check(r.recs.length === (sc.report === 'busy' ? 2 : 1), sc.report === 'busy' ? `two records, the session's (${r.recs[0]?.trigger?.why}) and the report's` : sc.report !== undefined ? 'one record, the report\'s' : 'one record, sent without being asked');
    if (!r.recs.length) continue;
    const mine = sc.report !== undefined ? r.recs.find((x) => x.trigger?.why === 'report') ?? r.recs[0] : r.recs[0];
    const rec = { at: new Date().toISOString(), session: `check-${sc.name}`, game: 'draw-probe-check', ...mine };
    fs.appendFileSync(telemetry, JSON.stringify(rec) + '\n');
    const text = execFileSync(process.execPath, [path.join(root, 'tools/dev/draw-probe.mjs'), telemetry, '--session', rec.session, '--out', out], { encoding: 'utf8' });
    fs.writeFileSync(path.join(out, `${sc.name}.txt`), text);
    console.log(text.split('\n').filter((l) => /^(started by|frames:|notes|VERDICT|  d\d)/.test(l)).join('\n'));
    console.log(`  (record ${Math.round(JSON.stringify(rec).length / 1024)} KB, made in ${rec.took?.ms} ms, longest slice ${rec.took?.longest} ms; reader output: ${path.join(out, `${sc.name}.txt`)})`);
    if (sc.report !== undefined) {
      check(rec.trigger?.why === 'report' && rec.trigger.id === 1, `started by the display report (${JSON.stringify(rec.trigger)})`);
      const b = r.bb[0];
      check(!!b && b.frames > 10 && b.notes.some((n) => /draw probe started/.test(n)), `the report's back-buffer strip, the probe named in its notes (${b ? `${b.frames} frames, A-B-B-A frames ${b.summary?.abbaFrames}` : 'none'})`);
      // (the display report as the page sends it, the probe beside it: the reader prints both)
      fs.appendFileSync(telemetry, JSON.stringify({ at: rec.at, event: 'display-report', v: 1, id: 1, session: rec.session, bb: null, screen: null, notes: [] }) + '\n');
      const rep = execFileSync(process.execPath, [path.join(root, 'tools/dev/flicker-report.mjs'), telemetry, '--session', rec.session, '--out', out], { encoding: 'utf8' });
      check(/draw probe of this report .*VERDICT/s.test(rep), 'flicker-report.mjs prints the report\'s draw probe');
    } else check(sc.vary ? rec.trigger?.why === 'alternation' : ['still', 'flicker', 'alternation'].includes(rec.trigger?.why), `started by the flicker probe (${rec.trigger?.why})`);
    check(rec.summary.oddProbed >= 5, `odd frames found while probing: ${rec.summary.oddProbed} of ${rec.summary.probed}`);
    if (sc.path === 'inline') check(rec.path === 'worker' && rec.stamps, "the game's TEXTUREFACTOR came through the ring");
    // (the veil: 3rd draw from the frame's end — after / before ~0.20 in normal frames)
    const veil = text.split('\n').find((l) => /^ {2}d3 /.test(l)) ?? '';
    const med = Number((/after\/before ([\d.]+)/.exec(veil) ?? [])[1]);
    // (runs of 3 and 3: as many faulty frames as normal ones — the record's median picture is either, so the "normal"
    // frames' ratio is the veil's 0.20 or the faulty 1 - 0.8 x 0.3 = 0.76)
    check(Math.abs(med - 0.2) < 0.03 || (sc.fault === 'runs' && Math.abs(med - 0.76) < 0.03), `the veil's after/before ratio ~0.20${sc.fault === 'runs' ? ' (or 0.76: the faulty half taken as normal)' : ''} (${med})`);
    if (sc.fault === 'gl') check(/what GL makes of the same commands and values/.test(text), 'verdict: GL, the same values');
    if (sc.fault === 'game') check(/the game's own TEXTUREFACTOR changed/.test(text), "verdict: the game's values");
  }
} finally { await browser.close(); }
console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
process.exit(failed ? 1 : 0);
