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
    ctx.clearRect(0, 0, 1, 1); return;
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

function clear() { ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); shown = false; }

function draw(now, reading) {
  shown = true;
  const c = ctx, W = c.canvas.width / dpr, H = c.canvas.height / dpr;
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
  c.fillStyle = 'rgba(12,14,20,0.9)'; c.strokeStyle = 'rgba(214,166,92,0.55)'; c.lineWidth = 1;
  c.beginPath(); c.roundRect(0.5, 0.5, W - 1, H - 1, 10); c.fill(); c.stroke();
  // the bar: a light running along it, the proof the page is alive
  const bx = 16, by = H - 10, bw = W - 32, run = ((now / 1400) % 1) * (bw + 120) - 120;
  c.fillStyle = 'rgba(255,255,255,0.08)'; c.beginPath(); c.roundRect(bx, by, bw, 4, 2); c.fill();
  c.save(); c.beginPath(); c.roundRect(bx, by, bw, 4, 2); c.clip();
  const g = c.createLinearGradient(bx + run, 0, bx + run + 120, 0);
  g.addColorStop(0, 'rgba(232,160,64,0)'); g.addColorStop(0.5, 'rgba(240,170,70,1)'); g.addColorStop(1, 'rgba(232,160,64,0)');
  c.fillStyle = g; c.fillRect(bx + run, by, 120, 4); c.restore();
  c.textBaseline = 'alphabetic'; c.fillStyle = '#f2e6cf'; c.font = '600 15px system-ui, "Segoe UI", sans-serif';
  const title = reading ? S.data : S.busy;
  c.fillText(title, 16, 25);
  if (reading) {
    let rate = 0;
    if (marks.length > 1 && now - marks[0][0] > 800) rate = (done - marks[0][1]) / ((now - marks[0][0]) / 1000) / 1048576;
    const detail = `${num.format(done / 1048576)} ${S.mb}` + (rate > 0.05 ? ` · ${num.format(rate)} ${S.rate}` : '');
    c.font = '600 15px system-ui, "Segoe UI", sans-serif'; c.fillStyle = '#f0aa46';
    c.textAlign = 'right'; c.fillText(detail, W - 16, 25); c.textAlign = 'left';
  }
  c.font = '12.5px system-ui, "Segoe UI", sans-serif'; c.fillStyle = 'rgba(242,230,207,0.72)';
  c.fillText(`${reading ? S.dataNote : S.busyNote} (${Math.floor(held / 1000)} s)`, 16, 46);
  // (Chrome offers to close a page that has not answered a click for a while: it is only waiting)
  if (held > 8000) { c.fillStyle = '#f0aa46'; c.fillText(S.wait, 16, 66); }
}
