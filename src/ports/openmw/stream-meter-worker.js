// The indicator stream-meter.js shows while the OpenMW engine's page waits for its game data, drawn here so that it
// moves while that page's thread is held by the engine's read: shown when the page has painted nothing for a second
// and asked for game data meanwhile (or for three seconds whatever it does), gone at its next frame.
const TEXT = {
  en: { data: 'Loading the game data', busy: 'Loading…', mb: 'MB', rate: 'MB/s',
    dataNote: 'Not stuck: the game is receiving its files. Faster next time.', busyNote: 'Not stuck: the game is working.',
    wait: 'If Chrome says the page is not responding, choose “Wait”.' },
  fr: { data: 'Chargement des données du jeu', busy: 'Chargement…', mb: 'Mo', rate: 'Mo/s',
    dataNote: 'Pas bloqué : le jeu reçoit ses fichiers. Plus rapide la prochaine fois.', busyNote: 'Pas bloqué : le jeu travaille.',
    wait: 'Si Chrome dit que la page ne répond pas, choisis « Attendre ».' },
};
let ctx = null, dpr = 1, S = TEXT.en, num = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
let beat = performance.now(), hidden = false, shown = false;
let reads = 0, done = 0, pending = 0, lastRead = 0, held = 0;
const marks = [];   // [time, bytes received] of the last seconds: the rate
let arrived = null, seen = 0;   // (Orthros' streaming: its count of the bytes arrived, shared — exact, live)

/** Data asked for or arriving (a pause of 5 s: a new count). */
function arrive(now, bytes) {
  if (now - lastRead > 5000) { reads = done = pending = 0; marks.length = 0; }
  reads++; done += bytes; lastRead = now;
  marks.push([now, done]); while (marks.length > 2 && marks[0][0] < now - 4000) marks.shift();
}

onmessage = (e) => {
  const m = e.data, now = performance.now();
  if (m.canvas) {
    ctx = m.canvas.getContext('2d'); dpr = m.dpr || 1; S = TEXT[m.lang] ?? TEXT.en; num = new Intl.NumberFormat(m.lang, { maximumFractionDigits: 1 });
    // (a first, empty frame while the page's thread is free: the page shows this canvas's frames from then on, its
    // thread held or not — not before it has taken one)
    ctx.clearRect(0, 0, 1, 1);
    // (each font the indicator uses drawn once soon, while the page's thread is free, then wiped: a font's first use
    // in this worker waits for that thread — the whole hold long, were it the first one; measured in a real start:
    // one frame drawn in a 50 s hold)
    for (const at of [300, 3000]) setTimeout(warm, at);
    return;
  }
  if (m.beat) { beat = now; if (shown) clear(); return; }
  if ('hidden' in m) { hidden = !!m.hidden; beat = now; return; }
  if (m.arrived) { arrived = new Int32Array(m.arrived); seen = Atomics.load(arrived, 2); return; }
  if (m.read) {
    // (one read at a time: a new piece asked for is the end of the previous one — counted so when no exact count)
    if (arrived) arrive(now, 0); else { arrive(now, pending); pending = m.read; }
  }
};

setInterval(() => {
  const now = performance.now(); held = now - beat;
  if (arrived) { const cur = Atomics.load(arrived, 2), d = (cur - seen) | 0; seen = cur; if (d > 1) arrive(now, d); }
  const reading = reads > 0 && now - lastRead < held + 500;
  if (ctx && !hidden && (held > 1000 && reading || held > 3000)) draw(now, reading); else if (shown) clear();
}, 100);

const FONTS = ['600 15px system-ui, "Segoe UI", sans-serif', '700 17px system-ui, "Segoe UI", sans-serif', '600 13px system-ui, "Segoe UI", sans-serif', '12.5px system-ui, "Segoe UI", sans-serif'];
function warm() {
  if (shown) return;
  const glyphs = Object.values(S).join(' ') + ' 0123456789 % / · , .';
  for (const font of FONTS) { ctx.font = font; ctx.fillText(glyphs, 0, 20); }
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

function clear() { ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); shown = false; }

function draw(now, reading) {
  shown = true;
  const c = ctx, W = c.canvas.width / dpr, H = c.canvas.height / dpr;
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
  c.fillStyle = 'rgba(12,14,20,0.9)'; c.strokeStyle = 'rgba(214,166,92,0.55)'; c.lineWidth = 1;
  c.beginPath(); c.roundRect(0.5, 0.5, W - 1, H - 1, 10); c.fill(); c.stroke();
  // (the step of the game's data being read, when earlier sessions tell how much it is: Orthros' streaming, ctrl[4], [5])
  const kb = arrived ? Atomics.load(arrived, 4) : 0, of = arrived ? Atomics.load(arrived, 5) : 0;
  const pct = reading && of > 0 ? Math.min(99, Math.floor(kb / of * 100)) : -1;
  // the bar: filled as far as the step is, a light running along it — the proof the page is alive
  const bx = 16, by = H - 12, bw = W - 32, run = ((now / 1400) % 1) * (bw + 120) - 120;
  c.fillStyle = 'rgba(255,255,255,0.08)'; c.beginPath(); c.roundRect(bx, by, bw, 5, 2.5); c.fill();
  c.save(); c.beginPath(); c.roundRect(bx, by, bw, 5, 2.5); c.clip();
  if (pct >= 0) { c.fillStyle = 'rgba(232,160,64,0.85)'; c.fillRect(bx, by, bw * pct / 100, 5); }
  const g = c.createLinearGradient(bx + run, 0, bx + run + 120, 0);
  g.addColorStop(0, 'rgba(255,214,140,0)'); g.addColorStop(0.5, 'rgba(255,214,140,0.9)'); g.addColorStop(1, 'rgba(255,214,140,0)');
  c.fillStyle = g; c.fillRect(bx + run, by, 120, 5); c.restore();
  c.textBaseline = 'alphabetic'; c.textAlign = 'left'; c.fillStyle = '#f2e6cf'; c.font = '600 15px system-ui, "Segoe UI", sans-serif';
  c.fillText(reading ? S.data : S.busy, 16, 25);
  if (pct >= 0) { c.textAlign = 'right'; c.fillStyle = '#f0aa46'; c.font = '700 17px system-ui, "Segoe UI", sans-serif'; c.fillText(`${pct} %`, W - 16, 26); c.textAlign = 'left'; }
  // the second line: what arrived (of how much), how fast, for how long
  let rate = 0;
  if (marks.length > 1 && now - marks[0][0] > 800) rate = (done - marks[0][1]) / ((now - marks[0][0]) / 1000) / 1048576;
  const parts = [];
  if (reading) parts.push(pct >= 0 ? `${num.format(kb / 1024)} / ${num.format(of / 1024)} ${S.mb}` : `${num.format(done / 1048576)} ${S.mb}`);
  if (reading && rate > 0.05) parts.push(`${num.format(rate)} ${S.rate}`);
  parts.push(`${Math.floor(held / 1000)} s`);
  c.font = '600 13px system-ui, "Segoe UI", sans-serif'; c.fillStyle = '#f0aa46'; c.fillText(parts.join(' · '), 16, 46);
  c.font = '12.5px system-ui, "Segoe UI", sans-serif'; c.fillStyle = 'rgba(242,230,207,0.72)';
  // (Chrome offers to close a page that has not answered a click for a while: it is only waiting)
  c.fillText(held > 8000 ? S.wait : reading ? S.dataNote : S.busyNote, 16, 66);
}
