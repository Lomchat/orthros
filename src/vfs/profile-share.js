// One profile per game (docs/profiles.md): the saves and settings of every version of a game folder are one profile —
// like on a PC, where a patch keeps them —, unless a version says `ownProfile: true` in its manifest. The catalog gives
// each version its `profileKey` (src/host/game-catalog.js): the game folder's id, or the version's own name. Every
// runtime keeps its profile under it, through the names made here; the copies kept per version before (one per version
// name) are merged into it by migrateProfile below (each copy once, again when it changed) with the one merge
// (profile-merge.js), and left in place.
import { mergeProfiles } from './profile-merge.js';

/** A version's profile key (a manifest from the catalog, /api/manifest or /api/manifests; an older one: its name). */
export const profileKeyOf = (manifest) => manifest?.profileKey ?? manifest?.name ?? null;

/** The OPFS folder of a Windows game's profile (and the one each version had before: profileDir(<version name>)). */
export const profileDir = (key) => 'orthros-' + key;

/**
 * A browser port's profile database (GoldSrc, re3: a 'profile' store; OpenMW: its /userdata IDBFS database, one per
 * account `scope` beside the anonymous one). Never an installation's own database (the manifest's saveKey,
 * 'orthros-port:<game>:<dir>': the game files a page fetched before, multiplayer and launcher state), which stays per
 * version.
 */
export const portProfileDb = (key, scope = null) => `orthros-profile:${key}${scope ? ':user:' + scope : ''}`;

/**
 * The versions whose earlier per-version copies the profile takes once: [{ name, saveKey? }] (the server's
 * /api/manifest `profileSources`; none from an older server: the version alone).
 */
export const profileSourcesOf = (manifest) => (Array.isArray(manifest?.profileSources) ? manifest.profileSources : [{ name: manifest?.name, saveKey: manifest?.saveKey ?? null }]).filter((s) => s?.name);

/** Does this version's profile take copies kept under another name (a key that is not the version's name alone)? */
export const sharesProfile = (manifest) => profileSourcesOf(manifest).some((s) => s.name !== profileKeyOf(manifest));

/**
 * The account's sync of a version's profile (cloud-sync.js CloudSave): { game: its key, shared: its first sync's
 * knowledge of the merge of the per-version copies, or null for a profile of one version's copies only }.
 */
export const cloudProfile = (manifest, scope = null) => ({
  game: profileKeyOf(manifest),
  shared: sharesProfile(manifest) ? { marker: () => mergedMarker(profileKeyOf(manifest), scope), settings: manifest.profileSettings ?? [] } : null,
});

const markerKey = (key, scope) => `orthros.profileMerged.${key}${scope ? '.' + scope : ''}`;
/**
 * What this browser's merge of the per-version copies into profile `key` did (null: not done yet): { at, sources:
 * [{ name, files, hash }] — each copy's content hash as the account's sync computes it (cloud-sync.js contentHash), the
 * number of its files —, merged (the result's hash), renamed (files kept beside a newer one) }. cloud-sync.js reads it
 * at the profile's first sync with the account: a device whose copies were all in step with the account takes the
 * account's merged copy without a question.
 */
export function mergedMarker(key, scope = null, storage = globalThis.localStorage) {
  try { return JSON.parse(storage?.getItem(markerKey(key, scope)) ?? 'null'); } catch { return null; }
}

/**
 * The per-version copies of profile `key` merged into it (under an exclusive Web Lock, so that two tabs never do it at
 * once). The marker, in the page's storage, records each copy's content hash as merged: at every start a copy missing
 * from it (a version that joined the game later) or changed since (written by a page of before still open) is merged
 * again into the profile as it is — the others are not, so a file the player removed since does not come back. The
 * copies are only read: a player deletes them from the data window. A copy that cannot be read stops it, no marker
 * written: done at the next start (done again it gives the same files — the merge is idempotent).
 * @param {{
 *   key: string, scope?: string | null,
 *   sources: { name: string, read: () => Promise<{ path: string, data: any, mtime?: number }[] | null>, target?: boolean }[],
 *   target: { read: () => Promise<any[] | null>, write: (files: any[]) => Promise<void> },
 *   hashOf: (name: string, files: any[]) => Promise<string>,
 *   settings?: string[], storage?: Storage, log?: (msg: string) => void,
 * }} o  the sources in the caller's order of preference (on equal dates, the first is the newer: the version being
 *   started); `read()`: a copy's files, null when it does not exist (an error: not read); a source `target`: the
 *   profile's own storage (a Windows game whose key is also a version's name: one OPFS folder — the profile itself,
 *   never merged again); `target.read`: the profile's files now; `hashOf`: a copy's content hash as the account's sync
 *   computes it.
 */
export async function migrateProfile(o) {
  const { key, scope = null, sources, target, hashOf, settings, storage = globalThis.localStorage, log = () => {} } = o;
  const run = async () => {
    const done = mergedMarker(key, scope, storage), before = new Map((done?.sources ?? []).map((s) => [s.name, s.hash]));
    const copies = [];
    for (const s of sources) {
      const files = (await s.read()) ?? [];
      copies.push({ label: s.name, at: Math.max(0, ...files.map((f) => f.mtime ?? 0)), files, source: true, target: !!s.target, hash: await hashOf(s.name, files) });
    }
    // (the copies to take: all the first time; then those new or changed since)
    const fresh = done ? copies.filter((c) => !c.target && before.get(c.label) !== c.hash) : copies;
    if (done && !fresh.length) return done;
    // (the profile's own files when it is none of the copies, or merged before: what an earlier page wrote — the same
    // again, or the game played since —, first among equal dates)
    const inputs = done ? [...copies.filter((c) => c.target), ...fresh] : [...copies];
    if (!inputs.some((c) => c.target)) {
      const own = (await target.read()) ?? [];
      if (own.length) inputs.unshift({ label: key, at: Math.max(0, ...own.map((f) => f.mtime ?? 0)), files: own });
    }
    const full = inputs.filter((c) => c.files.length);
    const merged = full.length ? mergeProfiles(full, { settings }) : { files: [], report: [] };
    // (the profile's own files alone: nothing to write)
    const alone = full.length === 1 && (full[0].target || !full[0].source);
    // (the result as the profile now holds it — names as its storage spells them —: what the account's sync will read)
    let now = merged.files;
    if (full.length && !alone) { await target.write(merged.files); now = (await target.read()) ?? merged.files; }
    const renamed = merged.report.filter((r) => r.action === 'renamed').map((r) => r.to);
    const marker = {
      at: Date.now(),
      sources: copies.map((c) => ({ name: c.label, files: c.files.length, hash: c.hash })),
      merged: await hashOf(key, now),
      renamed: [...(done?.renamed ?? []), ...renamed],
    };
    try { storage?.setItem(markerKey(key, scope), JSON.stringify(marker)); } catch { /* storage off: done again next time, the same */ }
    if (full.length > 1) log(`profile ${key}: ${full.map((c) => c.label).join(', ')} merged (${merged.files.length} files${renamed.length ? `, ${renamed.length} kept beside a newer one` : ''})`);
    return marker;
  };
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request(`orthros-profile-merge:${key}${scope ? ':' + scope : ''}`, { mode: 'exclusive' }, run) : run();
}
