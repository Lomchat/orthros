// What the page says about the network while the game waits for its files (docs/slow-network.md): the measured rate,
// what came, and how long the current step should take — instead of a black screen. Pure functions of the worker's
// `net` stats (NetLink.snapshot plus waiting / stepWire, see worker.js netInfo), shared by the loading screen, the
// waiting overlay and the bench banner.

/** "85 KB/s", "1.2 MB/s" (bytes per second) */
export function fmtRate(bps, lang = 'en') {
  if (!(bps > 0)) return '—';
  return frUnits(bps >= 1048576 ? `${(bps / 1048576).toFixed(bps >= 10 * 1048576 ? 0 : 1)} MB/s` : `${Math.max(1, Math.round(bps / 1024))} KB/s`, lang);
}
/** "14 MB", "1.3 GB", "640 KB" (bytes; `lang` 'fr': "14 Mo", "1,3 Go") */
export function fmtBytes(n, lang = 'en') {
  if (!(n > 0)) return frUnits('0 MB', lang);
  return frUnits(n >= 1e9 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`, lang);
}
/** French units: octets, a decimal comma. */
const frUnits = (t, lang) => (lang === 'fr' ? t.replace(/(\d)\.(\d)/, '$1,$2').replace(/([KMG])B/, '$1o') : t);
/** "about 4 min", "about 40 s", "about 2 h 10 min" (seconds; `lang` 'fr': "environ 4 min") */
export function fmtDuration(s, lang = 'en') {
  if (!Number.isFinite(s) || s < 0) return '';
  const about = lang === 'fr' ? 'environ' : 'about';
  if (s < 90) return `${about} ${Math.max(5, Math.round(s / 5) * 5)} s`;
  if (s < 3600) return `${about} ${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600), m = Math.round((s - h * 3600) / 60);
  return `${about} ${h} h${m ? ` ${m} min` : ''}`;
}
/** seconds the link needs for `wire` bytes at the measured rate, or null */
export function etaSeconds(wire, net) { return net?.bw > 0 && wire > 0 ? wire / net.bw : null; }

/** bytes received so far over the link (the game's reads and the background downloads) */
export const received = (net) => (net ? (net.demandBytes ?? 0) + (net.bgBytes ?? 0) : 0);

/**
 * The waiting message when the game waits for game data from the network: { title, detail } or null (not waiting).
 * `title` names the rate; `detail` what came and, when the learned order tells how much the current step still needs,
 * about how long it takes at that rate.
 */
export function netWaitText(net, lang = 'en') {
  if (!net || !net.waiting) return null;
  const fr = lang === 'fr';
  const parts = [`${fmtBytes(received(net), lang)} ${fr ? 'reçus' : 'received'}`];
  const eta = etaSeconds(net.stepWire, net);
  if (eta !== null && eta >= 5) parts.push(fr ? `${fmtDuration(eta, lang)} pour cette étape (${fmtBytes(net.stepWire, lang)} à venir)` : `${fmtDuration(eta)} for this step (${fmtBytes(net.stepWire)} to come)`);
  if (net.bw > 0 && net.bw < 512 * 1024) parts.push(fr ? 'connexion lente : l’accueil peut d’abord télécharger tout le jeu' : 'a slow connection: the home screen can download the whole game first');
  const rate = net.bw > 0 ? fmtRate(net.bw, lang) : fr ? 'mesure de la connexion' : 'measuring the connection';
  return { title: fr ? `Téléchargement des données du jeu — ${rate}` : `Downloading game data — ${rate}`, detail: parts.join(' · ') };
}

/** The connection as a bench record carries it (bytes/s, ms, bytes), or null. */
export function benchNetwork(net) {
  if (!net) return null;
  return { bw: net.bw ?? null, measured: !!net.measured, rtt: net.rtt ?? null, demandBytes: net.demandBytes ?? 0, demandRequests: net.demandRequests ?? 0, demandMs: Math.round(net.demandMs ?? 0), bgBytes: net.bgBytes ?? 0, bgRequests: net.bgRequests ?? 0, aborted: net.abortedRequests ?? 0 };
}
