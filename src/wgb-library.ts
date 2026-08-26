import { ZipArchive, BlobSource } from "@orthros/formats/zip";
import { asBlobPart } from "./dom-buffer";

/** A bring-your-own bundle the user has added — lives in OPFS orthros/wgb-cache/. */
export interface AddedGame {
  /** OPFS cache filename / key (e.g. "morrowind.wgb"). */
  key: string;
  /** Display name from the bundle's manifest, or a prettified filename. */
  name: string;
  /** URL whose basename is the cache key → worker's load_bundle{url} hits the cached copy. */
  url: string;
  /** From manifest.meta (WgbMeta), when the bundle carries it. */
  developer?: string;
  year?: number;
  /** Object URL for the in-bundle cover image (manifest.meta.cover), if present. */
  coverUrl?: string;
}

/** Partial manifest override authored in the editor (deep-merged onto the bundle at load). */
export interface ManifestOverride {
  name?: string;
  entrypoint?: string;
  args?: string;
  emulator?: Record<string, unknown>;
}

const OVERRIDES_FILE = "_manifest-overrides.json";

/** Read manifest.json from a .wgb without loading the whole file (tail + entry only). */
async function readManifest(file: File): Promise<Record<string, any> | null> {
  try {
    const archive = new ZipArchive(new BlobSource(file));
    await archive.init();
    const entry = archive.getEntry("manifest.json");
    if (!entry) return null;
    return JSON.parse(new TextDecoder().decode(await archive.readEntry(entry)));
  } catch {
    return null; // not a readable wgb / locked by a running game
  }
}

/** Cover object URLs by cache key — reused across refreshes, revoked when the bundle changes. */
const coverUrlCache = new Map<string, { stamp: string; url: string }>();

/**
 * Manifest + in-bundle cover for a library card, in one archive session.
 * The cover (manifest.meta.cover, ROM-relative e.g. "rom/cover.png" or "cover.png")
 * is materialized as a cached object URL.
 */
async function readCardMeta(
  key: string,
  file: File,
): Promise<{ manifest: Record<string, any> | null; coverUrl?: string }> {
  try {
    const archive = new ZipArchive(new BlobSource(file));
    await archive.init();
    const entry = archive.getEntry("manifest.json");
    if (!entry) return { manifest: null };
    const manifest = JSON.parse(new TextDecoder().decode(await archive.readEntry(entry)));

    const cover = typeof manifest?.meta?.cover === "string" ? manifest.meta.cover : undefined;
    if (!cover) return { manifest };

    const stamp = `${file.size}:${file.lastModified}`;
    const cached = coverUrlCache.get(key);
    if (cached?.stamp === stamp) return { manifest, coverUrl: cached.url };
    if (cached) URL.revokeObjectURL(cached.url);

    const rom = typeof manifest?.rom === "string" ? manifest.rom : "rom";
    const coverEntry =
      archive.getEntry(cover) ?? archive.getEntry(`${rom}/${cover}`.replace(/\/+/g, "/"));
    if (!coverEntry) return { manifest };
    const url = URL.createObjectURL(new Blob([asBlobPart(await archive.readEntry(coverEntry))]));
    coverUrlCache.set(key, { stamp, url });
    return { manifest, coverUrl: url };
  } catch {
    return { manifest: null };
  }
}

async function orthrosDir(create = false): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle("bottleship", { create });
}

async function cachedFile(key: string): Promise<File | null> {
  try {
    const cacheDir = await (await orthrosDir()).getDirectoryHandle("wgb-cache");
    return await (await cacheDir.getFileHandle(key)).getFile();
  } catch {
    return null;
  }
}

/** Load the full per-bundle override DB ({ "<key>": {…} }). */
export async function loadOverrides(): Promise<Record<string, ManifestOverride>> {
  try {
    const fh = await (await orthrosDir()).getFileHandle(OVERRIDES_FILE);
    const db = JSON.parse(await (await fh.getFile()).text());
    return db && typeof db === "object" ? db : {};
  } catch {
    return {};
  }
}

/** Write (or clear, when `patch` is null) the override for one bundle. */
export async function saveOverride(key: string, patch: ManifestOverride | null): Promise<void> {
  const db = await loadOverrides();
  if (patch && Object.keys(patch).length) db[key] = patch;
  else delete db[key];
  const dir = await orthrosDir(true);
  const fh = await dir.getFileHandle(OVERRIDES_FILE, { create: true });
  const w = await fh.createWritable();
  await w.write(new TextEncoder().encode(JSON.stringify(db, null, 2)));
  await w.close();
}

/** Bundle manifest deep-merged with its override — what the editor shows and the loader applies. */
export async function getEffectiveManifest(key: string): Promise<Record<string, any>> {
  const file = await cachedFile(key);
  const base = (file && (await readManifest(file))) ?? {};
  const ov = (await loadOverrides())[key];
  return ov ? deepMerge(base, ov as Record<string, any>) : base;
}

function deepMerge(a: Record<string, any>, b: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = Array.isArray(a) ? [...a] : { ...a };
  for (const k of Object.keys(b)) {
    const v = b[k];
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])
        ? deepMerge(out[k], v)
        : v;
  }
  return out;
}

function prettifyKey(key: string): string {
  return key
    .replace(/\.wgb$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * List BYO bundles cached in OPFS wgb-cache/. `excludeKeys` drops bundles that are just
 * cached copies of built-in games (so they don't show twice).
 */
export async function listAddedGames(excludeKeys: Set<string> = new Set()): Promise<AddedGame[]> {
  try {
    const cacheDir = await (await orthrosDir()).getDirectoryHandle("wgb-cache");
    const overrides = await loadOverrides();
    const out: AddedGame[] = [];
    for await (const [name, handle] of (cacheDir as any).entries()) {
      if (handle.kind !== "file") continue;
      if (!name.toLowerCase().endsWith(".wgb")) continue;
      if (excludeKeys.has(name.toLowerCase())) continue;
      const file = await (handle as FileSystemFileHandle).getFile();
      const overrideName = overrides[name]?.name?.trim();
      const { manifest, coverUrl } = await readCardMeta(name, file);
      const manifestName = manifest?.name;
      const display = overrideName || (typeof manifestName === "string" && manifestName.trim()) || prettifyKey(name);
      const meta = manifest?.meta ?? {};
      out.push({
        key: name,
        name: display,
        url: `/apps/byo/${name}`,
        ...(typeof meta.developer === "string" ? { developer: meta.developer } : {}),
        ...(typeof meta.year === "number" ? { year: meta.year } : {}),
        ...(coverUrl ? { coverUrl } : {}),
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  } catch {
    return []; // no cache dir yet / OPFS unavailable
  }
}

export async function removeAddedGame(key: string): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const orthros = await root.getDirectoryHandle("bottleship");
  const cacheDir = await orthros.getDirectoryHandle("wgb-cache");
  await cacheDir.removeEntry(key);
}
