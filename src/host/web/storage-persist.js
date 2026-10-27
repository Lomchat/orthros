// The browser's storage of the game data, the same for every runtime (CLAUDE.md "Standardization", docs/slow-network.md
// "Persistent storage"): a page asks once, before its first write of game data, that the origin's storage be persistent
// (StorageManager.persist: Chrome grants or refuses silently, by the site's engagement — no prompt; a best-effort origin's
// stores may be evicted when the disk runs short), and the telemetry of every runtime says what the browser gave
// ({ persisted, usage, quota }: withStorage — the Windows games' page, the ports' event records, the perf records of
// perf-page.js). Page side only: persist() does not exist in workers (they have persisted() and estimate()).

const MiB = 1 << 20;
/** bytes as whole MiB (the telemetry needs no more: a quota to the byte tells the disk) */
const mib = (n) => (Number.isFinite(n) && n >= 0 ? Math.round(n / MiB) : null);

/**
 * The origin's storage now: { persisted (true, false; null unknown), usageMB, quotaMB } — null without a StorageManager.
 * @param {any} [nav] the navigator (a test's)
 */
export async function storageState(nav = globalThis.navigator) {
  const sm = nav?.storage; if (!sm) return null;
  const [persisted, est] = await Promise.all([
    Promise.resolve().then(() => sm.persisted?.()).catch(() => null),
    Promise.resolve().then(() => sm.estimate?.()).catch(() => null),
  ]);
  return { persisted: typeof persisted === 'boolean' ? persisted : null, usageMB: mib(est?.usage), quotaMB: mib(est?.quota) };
}

/**
 * Ask that the origin's storage be persistent unless it is (never throws): storageState() after it, with `asked` (the
 * page called persist() — a refusal leaves `persisted` false) — null without a StorageManager.
 */
export async function askPersist(nav = globalThis.navigator) {
  const sm = nav?.storage; if (!sm) return null;
  let asked = false;
  try { if (typeof sm.persist === 'function' && (await sm.persisted?.()) !== true) { asked = true; await sm.persist(); } } catch { /* refused */ }
  const st = await storageState(nav);
  return st && { ...st, asked };
}

/**
 * A page's storage, for its telemetry: `ask()` (once a page: before its first write of game data — the game's start, a
 * Prepare or a download; the later calls the same promise) then `state`, the last known (null until known).
 */
export function pageStorage(nav = globalThis.navigator) {
  const s = {
    /** @type {{ persisted: boolean|null, usageMB: number|null, quotaMB: number|null, asked?: boolean }|null} */
    state: null,
    asking: null,
    ask() { return (s.asking ??= askPersist(nav).then((st) => (s.state = st), () => null)); },
    /** the state read again (the usage grows as the game data comes), `asked` kept */
    read() { return storageState(nav).then((st) => (s.state = st && { ...st, asked: !!s.state?.asked }), () => s.state); },
  };
  return s;
}

/** A telemetry env with the storage's state (`storage`: pageStorage's, null while unknown) — every runtime's. */
export const withStorage = (env, storage) => ({ ...env, storage: storage ?? null });
