// Put into the OpenMW engine's pages by the Orthros server (src/host/openmw.js, withFrameMeter): what the page shows
// while the engine waits for its game data. The engine reads the files it streams (the engine's streamfs.js) on the
// page's thread, 2 MB at a time from the network the first time, and the page cannot paint until the read ends: a
// minute or more when a new game or a new area needs hundreds of MB. This indicator is drawn by a worker
// (stream-meter-worker.js, an OffscreenCanvas: its frames reach the screen without the page's thread) from what the
// page's thread tells it before each wait (the pieces streamfs.js's worker is asked for) and from the frames it stops
// getting. Over the top page (the Orthros page around the engine, its loading screen too), under its header. Nothing
// changes in the engine.
(() => {
  if (typeof OffscreenCanvas !== 'function' || !HTMLCanvasElement.prototype.transferControlToOffscreen) return;
  let lang = null;
  try { lang = localStorage.getItem('orthros.lang'); } catch { /* storage off */ }
  if (!lang) lang = (navigator.languages?.length ? navigator.languages : [navigator.language]).map((l) => String(l).slice(0, 2).toLowerCase()).find((l) => ['fr', 'en'].includes(l)) ?? 'en';
  const meter = new Worker('/src/ports/openmw/stream-meter-worker.js');
  const send = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (m, ...rest) {
    // (a piece streamfs.js's worker is asked for, { start, end, gen, url | id }: the page's thread waits for it next)
    if (this !== meter && m && typeof m.gen === 'number' && typeof m.start === 'number' && typeof m.end === 'number') send.call(meter, { read: m.end - m.start });
    return send.call(this, m, ...rest);
  };
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
