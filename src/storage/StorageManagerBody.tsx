import React from "react";
import { DownloadSimple, Trash, UploadSimple } from "@phosphor-icons/react";
import {
  type CachedBundleInfo,
  type GameStorageInfo,
  type StorageEstimate,
  evictCachedBundle,
  evictGameContainer,
  evictPartialDownloads,
  exportGameContainer,
  formatBytes,
  getCachedBundleFile,
  getStorageBreakdown,
  getStorageEstimate,
  importGameContainer,
  listCachedBundles,
  listGameStorage,
  requestPersistentStorage,
} from "../storage-manager";
import type { StorageBreakdown, StorageBreakdownKind } from "../storage-breakdown";
import { downloadBlob, pickFile, SettingsIconBtn } from "../settings/SettingsIconBtn";
import { asBlobPart } from "../dom-buffer";
import s from "./StorageManagerBody.module.css";
import sh from "../ui/SectionHeading/SectionHeading.module.css";
import hm from "../ui/Hint/Hint.module.css";
import bm from "../ui/Button/Button.module.css";

interface BreakdownRow {
  kind: StorageBreakdownKind | "other-site";
  label: string;
  description: string;
  color: string;
  bytes: number;
  files?: number;
}

export default function StorageManagerBody({ active }: { active: boolean }): React.ReactElement {
  const [estimate, setEstimate] = React.useState<StorageEstimate | null>(null);
  const [breakdown, setBreakdown] = React.useState<StorageBreakdown | null>(null);
  const [games, setGames] = React.useState<GameStorageInfo[]>([]);
  const [bundles, setBundles] = React.useState<CachedBundleInfo[]>([]);
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    try {
      const [est, g, b] = await Promise.all([getStorageEstimate(), listGameStorage(), listCachedBundles()]);
      const detail = await getStorageBreakdown(est.usageBytes);
      setEstimate(est);
      setBreakdown(detail);
      setGames(g);
      setBundles(b);
    } finally {
      setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const usedPct =
    estimate && estimate.quotaBytes > 0 ? Math.min(100, (estimate.usageBytes / estimate.quotaBytes) * 100) : 0;

  const allBreakdownRows: BreakdownRow[] = breakdown ? [
    {
      kind: "game-files",
      label: "Ready-to-play game files",
      description: "Complete local WGB copies",
      color: "var(--cyan)",
      ...breakdown.buckets["game-files"],
    },
    {
      kind: "partial-downloads",
      label: "Partial downloads",
      description: "Resumable .part files and maps not shown below",
      color: "var(--amber)",
      ...breakdown.buckets["partial-downloads"],
    },
    {
      kind: "saves-settings",
      label: "Saves & settings",
      description: "Writable game overlays and registry",
      color: "var(--violet)",
      ...breakdown.buckets["saves-settings"],
    },
    {
      kind: "app-support",
      label: "App support files",
      description: "Integrity maps, metadata and temporary data",
      color: "#76c7a0",
      ...breakdown.buckets["app-support"],
    },
    {
      kind: "other-opfs",
      label: "Other OPFS files",
      description: "Files outside Orthros storage",
      color: "#8994aa",
      ...breakdown.buckets["other-opfs"],
    },
    {
      kind: "other-site",
      label: "Other / browser-managed data",
      description: "Cache Storage, IndexedDB, locked files or overhead",
      color: "#59667e",
      bytes: breakdown.otherSiteBytes,
    },
  ] : [];
  const breakdownRows = allBreakdownRows.filter((row) => row.bytes > 0 || row.kind === "saves-settings");

  return (
    <>
      <h3 className={sh["sect-h"]}>Browser storage</h3>
      {estimate ? (
        <div className={s["usage"]}>
          <div className={s["usage__bar"]}>
            <div className={s["usage__seg"]} style={{ width: `${usedPct}%`, background: usedPct > 90 ? "var(--coral)" : "var(--cyan)" }} />
          </div>
          <div className={s["usage__legend"]}>
            <span>
              <i style={{ background: "var(--cyan)" }} />
              {formatBytes(estimate.usageBytes)} used
            </span>
            <span style={{ marginLeft: "auto", color: "var(--fg-2)" }}>
              {formatBytes(estimate.usageBytes)} / {formatBytes(estimate.quotaBytes)} ·{" "}
              {estimate.persisted ? "persistent ✓" : "not persistent"}
            </span>
          </div>
          {breakdown && (
            <div className={s["breakdown"]}>
              <div className={s["breakdown__title"]}>
                <span>Where this space is used</span>
                <span>{breakdown.scannedFiles} local file{breakdown.scannedFiles === 1 ? "" : "s"}</span>
              </div>
              <div className={s["breakdown__bar"]} aria-label="Storage usage breakdown">
                {breakdownRows.map((row) => {
                  const pct = estimate.usageBytes > 0 ? Math.min(100, (row.bytes / estimate.usageBytes) * 100) : 0;
                  return pct > 0 ? (
                    <span
                      key={row.kind}
                      title={`${row.label}: ${formatBytes(row.bytes)}`}
                      style={{ width: `${pct}%`, background: row.color }}
                    />
                  ) : null;
                })}
              </div>
              <div className={s["breakdown__rows"]}>
                {breakdownRows.map((row) => (
                  <div className={s["breakdown__row"]} key={row.kind}>
                    <i style={{ background: row.color }} />
                    <div className={s["breakdown__text"]}>
                      <strong>{row.label}</strong>
                      <span>
                        {row.description}
                        {row.files !== undefined && ` · ${row.files} file${row.files === 1 ? "" : "s"}`}
                      </span>
                    </div>
                    <span className={s["breakdown__size"]}>{formatBytes(row.bytes)}</span>
                    {row.kind === "partial-downloads" && row.bytes > 0 && (
                      <SettingsIconBtn
                        icon={Trash}
                        title="Delete partial downloads"
                        danger
                        disabled={busy}
                        onClick={async () => {
                          if (!confirm("Delete all partial game downloads? Complete game files, saves and settings will be kept. Close any game that is still downloading first.")) return;
                          setBusy(true);
                          try {
                            const result = await evictPartialDownloads();
                            const freed = formatBytes(result.freedBytes);
                            const failed = result.failedFiles > 0
                              ? ` ${result.failedFiles} file${result.failedFiles === 1 ? " is" : "s are"} still in use; close the game and try again.`
                              : "";
                            alert(`Removed ${result.removedFiles} partial file${result.removedFiles === 1 ? "" : "s"} and freed ${freed}.${failed}`);
                            await refresh();
                          } finally {
                            setBusy(false);
                          }
                        }}
                      />
                    )}
                  </div>
                ))}
              </div>
              {breakdown.unreadableFiles > 0 && (
                <p className={s["breakdown__note"]}>
                  {breakdown.unreadableFiles} file{breakdown.unreadableFiles === 1 ? " was" : "s were"} in use and could not be counted. Close the game, then refresh for an exact breakdown.
                </p>
              )}
              {breakdown.scannedBytes > estimate.usageBytes && (
                <p className={s["breakdown__note"]}>
                  Partial files can be sparse: their logical file sizes may exceed the physical usage reported by the browser.
                </p>
              )}
            </div>
          )}
          {!estimate.persisted && (
            <button
              className={bm["btn"]}
              style={{ marginTop: 10 }}
              onClick={async () => {
                await requestPersistentStorage();
                void refresh();
              }}
            >
              Make persistent
            </button>
          )}
        </div>
      ) : (
        <p className={hm["hint"]}>Reading storage usage…</p>
      )}

      <h3 className={sh["sect-h"]} style={{ marginTop: 8 }}>
        Per-game storage
      </h3>
      {games.length === 0 ? (
        <p className={hm["hint"]}>No game data yet.</p>
      ) : (
        <div className={s["glist"]}>
          {games.map((g) => (
            <div className={s["glist__row"]} key={g.containerDir}>
              <div>
                <div className={s["glist__name"]}>{g.containerDir}</div>
                <div className={s["glist__sub"]}>overlay + registry</div>
              </div>
              <span className={s["glist__sz"]}>{formatBytes(g.totalBytes)}</span>
              <div className={s["glist__actions"]}>
                <SettingsIconBtn
                  icon={DownloadSimple}
                  title="Download saves (.zip)"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const bytes = await exportGameContainer(g.containerDir);
                      if (!bytes) {
                        alert("Nothing to export yet — this game has no saved data.");
                        return;
                      }
                      downloadBlob(asBlobPart(bytes), `${g.containerDir}-saves.zip`, "application/zip");
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
                <SettingsIconBtn
                  icon={UploadSimple}
                  title="Import saves (.zip)"
                  disabled={busy}
                  onClick={async () => {
                    const file = await pickFile(".zip");
                    if (!file) return;
                    if (!confirm(`Import saves into "${g.containerDir}"? Existing files with the same names are overwritten.`)) return;
                    setBusy(true);
                    try {
                      const n = await importGameContainer(g.containerDir, new Uint8Array(await file.arrayBuffer()));
                      alert(`Imported ${n} file${n === 1 ? "" : "s"}.`);
                      await refresh();
                    } catch (err) {
                      alert(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
                <SettingsIconBtn
                  icon={Trash}
                  title="Delete saves & settings"
                  danger
                  disabled={busy}
                  onClick={async () => {
                    if (!confirm(`Delete saves & settings for "${g.containerDir}"? This cannot be undone.`)) return;
                    await evictGameContainer(g.containerDir);
                    void refresh();
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 className={sh["sect-h"]} style={{ marginTop: 18 }}>
        Cached game files
      </h3>
      {bundles.length === 0 ? (
        <p className={hm["hint"]}>No cached bundles.</p>
      ) : (
        <div className={s["glist"]}>
          {bundles.map((b) => (
            <div className={s["glist__row"]} key={b.key}>
              <div>
                <div className={s["glist__name"]}>{b.key}</div>
                <div className={s["glist__sub"]}>ROM cache · re-downloadable</div>
              </div>
              <span className={s["glist__sz"]}>{formatBytes(b.bytes)}</span>
              <div className={s["glist__actions"]}>
                <SettingsIconBtn
                  icon={DownloadSimple}
                  title="Download .wgb bundle"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      const file = await getCachedBundleFile(b.key);
                      if (!file) {
                        alert("Couldn't read this bundle (it may be in use).");
                        return;
                      }
                      downloadBlob(file, b.key, "application/octet-stream");
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
                <SettingsIconBtn
                  icon={Trash}
                  title="Free cached files"
                  danger
                  disabled={busy}
                  onClick={async () => {
                    await evictCachedBundle(b.key);
                    void refresh();
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <p className={hm["hint"]} style={{ marginTop: 12 }}>
        Saves persist by default; <code>*.log · temp/** · cache/**</code> stay ephemeral.{" "}
        <a style={{ color: "var(--cyan-soft)", cursor: "pointer" }} onClick={() => void refresh()}>
          {busy ? "Refreshing…" : "Refresh"}
        </a>
      </p>
    </>
  );
}
