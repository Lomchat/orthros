// What the page says about the network while the game waits for its files (docs/slow-network.md): the measured rate,
// what came, and how long the current step should take — instead of a black screen. Pure functions of the worker's
// `net` stats (NetLink.snapshot plus waiting / stepWire, see worker.js netInfo), shared by the loading screen, the
// waiting overlay and the bench banner.

/** "85 KB/s", "1.2 MB/s" (bytes per second) */
export function fmtRate(bps) {
  if (!(bps > 0)) return '—';
  return bps >= 1048576 ? `${(bps / 1048576).toFixed(bps >= 10 * 1048576 ? 0 : 1)} MB/s` : `${Math.max(1, Math.round(bps / 1024))} KB/s`;
}
/** "14 MB", "1.3 GB", "640 KB" (bytes) */
export function fmtBytes(n) {
  if (!(n > 0)) return '0 MB';
  return n >= 1e9 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${Math.round(n / 1048576)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
/** "about 4 min", "about 40 s", "about 2 h 10 min" (seconds) */
export function fmtDuration(s) {
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 90) return `about ${Math.max(5, Math.round(s / 5) * 5)} s`;
  if (s < 3600) return `about ${Math.round(s / 60)} min`;
  const h = Math.floor(s / 3600), m = Math.round((s - h * 3600) / 60);
  return `about ${h} h${m ? ` ${m} min` : ''}`;
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
export function netWaitText(net) {
  if (!net || !net.waiting) return null;
  const parts = [`${fmtBytes(received(net))} received`];
  const eta = etaSeconds(net.stepWire, net);
  if (eta !== null && eta >= 5) parts.push(`${fmtDuration(eta)} for this step (${fmtBytes(net.stepWire)} to come)`);
  if (net.bw > 0 && net.bw < 512 * 1024) parts.push('a slow connection: the home screen can download the whole game first');
  return { title: `Downloading game data — ${net.bw > 0 ? fmtRate(net.bw) : 'measuring the connection'}`, detail: parts.join(' · ') };
}

/** The connection as a bench record carries it (bytes/s, ms, bytes), or null. */
export function benchNetwork(net) {
  if (!net) return null;
  return { bw: net.bw ?? null, measured: !!net.measured, rtt: net.rtt ?? null, demandBytes: net.demandBytes ?? 0, demandRequests: net.demandRequests ?? 0, demandMs: Math.round(net.demandMs ?? 0), bgBytes: net.bgBytes ?? 0, bgRequests: net.bgRequests ?? 0, aborted: net.abortedRequests ?? 0 };
}
