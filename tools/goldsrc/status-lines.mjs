// The players listed by the engine's `status` in a GoldSrc page's console (portSession.logs), for tools/goldsrc/check.mjs:
// after its "# score ping dev  playtime name" header, a line per client, bots included —
// "[07:34:55]  2    -1   57   mj 62.9879 qa-check-1-fgjvq". A name already on the server (the same account's earlier
// connection, until the server drops it) is played as "name (1)": still that player.

const PLAYER = /^\[[^\]]*\]\s+(\d+)\s+(-?\d+)\s+\S+\s+\S+\s+\S+\s+(.+?)(?: \((\d+)\))?$/;

/** One status line's player ({ slot, score, name, copy }), or null for any other line. */
export function playerLine(line) {
  const m = PLAYER.exec(line);
  return m && { slot: Number(m[1]), score: Number(m[2]), name: m[3], copy: m[4] === undefined ? 0 : Number(m[4]) };
}

/** The players of the last status printed in these logs (an empty list without one). */
export function lastStatus(logs) {
  const head = logs.findLastIndex((l) => /#\s+score\s+ping/.test(l));
  const players = [];
  for (let i = head + 1; head >= 0 && i < logs.length; i++) {
    const p = playerLine(logs[i]); if (!p) break;
    players.push(p);
  }
  return players;
}

/** The score a status in these logs gave this player (the latest one listing it), or null. */
export function scoreOf(logs, name) {
  for (let i = logs.length - 1; i >= 0; i--) { const p = playerLine(logs[i]); if (p && p.name === name) return p.score; }
  return null;
}

/** Whether the engine finished entering a server in these logs: its "client connected at" line (developer messages,
 * the page's ?debug), written once every signon message arrived — the server's first menus (a team's) come after. */
export function signedOn(logs) {
  return logs.some((l) => l.includes('client connected at '));
}

/** The distance between two `viewpos` origins ("x y z", the "org ( ... )" line's), or NaN if either is missing. */
export function distance(before, after) {
  const a = before?.trim().split(/\s+/).map(Number), b = after?.trim().split(/\s+/).map(Number);
  if (a?.length !== 3 || b?.length !== 3 || [...a, ...b].some((v) => !Number.isFinite(v))) return NaN;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
