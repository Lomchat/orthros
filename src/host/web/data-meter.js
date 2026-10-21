// The indicator every game shows while it waits for its game data (CLAUDE.md "Standardization": the engines that run
// in the page — imported by the GoldSrc and re3 pages, put into the OpenMW engine's page by the server, withFrameMeter).
// An engine reading its files synchronously holds the page's thread while they come (the page cannot paint: a minute or
// more when a new game or a new area needs hundreds of MB); one that suspends meanwhile (JSPI) does not, but waits all
// the same. The indicator is drawn by a worker (data-meter-worker.js, an OffscreenCanvas: its frames reach the screen
// without the page's thread) from the game data's shared counters (src/vfs/data-client.js: bytes received, the step's
// size, the reads waiting — attach()) and from the frames it stops getting. Over the top page (the Orthros page around
// an engine's frame, its loading screen too), under its header.
(() => {
  if (typeof OffscreenCanvas !== 'function' || !HTMLCanvasElement.prototype.transferControlToOffscreen) return;
  let lang = null;
  try { lang = localStorage.getItem('orthros.lang'); } catch { /* storage off */ }
  if (!lang) lang = (navigator.languages?.length ? navigator.languages : [navigator.language]).map((l) => String(l).slice(0, 2).toLowerCase()).find((l) => ['fr', 'en'].includes(l)) ?? 'en';
  const meter = new Worker('/src/host/web/data-meter-worker.js');
  const send = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (m, ...rest) {
    // (without the game data — OpenMW's own streaming, ?sfs=upstream —: a piece its worker is asked for, { start, end,
    // gen, url | id }, the page's thread waiting for it next)
    if (this !== meter && m && typeof m.gen === 'number' && typeof m.start === 'number' && typeof m.end === 'number') send.call(meter, { read: m.end - m.start });
    return send.call(this, m, ...rest);
  };
  // (the game data, src/vfs/data-client.js, hands over its counters: read live)
  window.orthrosDataMeter = { attach(buffer) { send.call(meter, { arrived: buffer }); } };
  let last = 0;
  const beat = (t) => { if (t - last > 100) { last = t; send.call(meter, { beat: 1 }); } requestAnimationFrame(beat); };
  requestAnimationFrame(beat);
  document.addEventListener('visibilitychange', () => send.call(meter, { hidden: document.hidden }));
  const place = () => {
    let doc = document;
    try { if (window.top.document.body) doc = window.top.document; } catch { /* another origin's page: this one */ }
    const w = 480, h = 90, dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = doc.createElement('canvas'); canvas.width = w * dpr; canvas.height = h * dpr; canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, { position: 'fixed', left: '50%', top: '56px', transform: 'translateX(-50%)', width: w + 'px', height: h + 'px', maxWidth: '96vw', zIndex: '2147483647', pointerEvents: 'none' });
    doc.body.append(canvas);
    addEventListener('pagehide', () => canvas.remove());
    const off = canvas.transferControlToOffscreen();
    send.call(meter, { canvas: off, dpr, lang }, [off]);
  };
  if (document.body) place(); else addEventListener('DOMContentLoaded', place);
})();
