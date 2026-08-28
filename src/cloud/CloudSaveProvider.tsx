import React from "react";
import { authClient } from "../auth/auth-client";
import {
  exportGameContainer,
  importGameContainer,
  listGameStorage,
} from "../storage-manager";
import {
  CloudSaveConflictError,
  cloudDeviceId,
  downloadRemoteSave,
  listRemoteSaves,
  sha256Hex,
  uploadRemoteSave,
  type RemoteSaveHead,
} from "./cloud-save-api";

export interface CloudConflict {
  containerId: string;
  localHash: string;
  remoteHash: string;
}

type SyncPhase = "signed-out" | "checking" | "synced" | "conflict" | "error";

interface CloudSaveContextValue {
  user: { id: string; name: string; email: string; image?: string | null } | null;
  sessionPending: boolean;
  ready: boolean;
  phase: SyncPhase;
  error: string | null;
  conflicts: CloudConflict[];
  refetchSession: () => Promise<void>;
  syncNow: () => Promise<void>;
  pushSnapshot: (containerId: string, bytes: Uint8Array) => Promise<void>;
  keepLocal: (containerId: string) => Promise<void>;
  useCloud: (containerId: string) => Promise<void>;
}

const CloudSaveContext = React.createContext<CloudSaveContextValue | null>(null);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function CloudSaveProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const session = authClient.useSession();
  const user = session.data?.user ?? null;
  const userId = user?.id ?? null;
  const [phase, setPhase] = React.useState<SyncPhase>("signed-out");
  const [readyUserId, setReadyUserId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [conflicts, setConflicts] = React.useState<CloudConflict[]>([]);
  const remoteHeads = React.useRef(new Map<string, RemoteSaveHead>());
  const generation = React.useRef(0);
  const syncInFlight = React.useRef<Promise<void> | null>(null);
  const deviceId = React.useMemo(() => cloudDeviceId(), []);

  const pushSnapshot = React.useCallback(async (containerId: string, bytes: Uint8Array): Promise<void> => {
    const localHash = await sha256Hex(bytes);
    const remote = remoteHeads.current.get(containerId);
    if (remote?.hash === localHash) return;
    try {
      const result = await uploadRemoteSave(containerId, bytes, remote?.hash ?? "none", deviceId);
      remoteHeads.current.set(containerId, {
        containerId,
        hash: result.hash,
        size: bytes.byteLength,
        deviceId,
        updatedAt: new Date().toISOString(),
      });
      setConflicts((current) => current.filter((item) => item.containerId !== containerId));
      setError(null);
      setPhase("synced");
    } catch (uploadError) {
      if (uploadError instanceof CloudSaveConflictError) {
        setConflicts((current) => [
          ...current.filter((item) => item.containerId !== containerId),
          { containerId, localHash, remoteHash: uploadError.remoteHash },
        ]);
        setPhase("conflict");
      } else {
        setError(errorMessage(uploadError));
        setPhase("error");
      }
      throw uploadError;
    }
  }, [deviceId]);

  const runSync = React.useCallback(async (): Promise<void> => {
    if (!userId) return;
    if (syncInFlight.current) return syncInFlight.current;
    const thisGeneration = ++generation.current;
    const syncingUserId = userId;
    setReadyUserId(null);
    const run = (async () => {
      setPhase("checking");
      setError(null);
      const remote = await listRemoteSaves();
      if (thisGeneration !== generation.current) return;
      remoteHeads.current = new Map(remote.map((head) => [head.containerId, head]));

      const local = await listGameStorage();
      const localIds = new Set(local.map((game) => game.containerDir));
      const foundConflicts: CloudConflict[] = [];

      // Import cloud-only containers first. Nothing local can be overwritten in this branch.
      for (const head of remote) {
        if (localIds.has(head.containerId)) continue;
        const bytes = await downloadRemoteSave(head.containerId);
        await importGameContainer(head.containerId, bytes);
      }

      // Local content is uploaded only when the cloud is empty or hashes match. Divergent
      // histories remain intact until the player explicitly chooses a side in the account UI.
      for (const game of local) {
        const bytes = await exportGameContainer(game.containerDir);
        if (!bytes) continue;
        const localHash = await sha256Hex(bytes);
        const head = remoteHeads.current.get(game.containerDir);
        if (!head) {
          await pushSnapshot(game.containerDir, bytes);
        } else if (head.hash !== localHash) {
          foundConflicts.push({ containerId: game.containerDir, localHash, remoteHash: head.hash });
        }
      }

      if (thisGeneration !== generation.current) return;
      setConflicts(foundConflicts);
      setPhase(foundConflicts.length > 0 ? "conflict" : "synced");
    })().catch((syncError) => {
      if (thisGeneration !== generation.current) return;
      setError(errorMessage(syncError));
      setPhase("error");
    }).finally(() => {
      if (thisGeneration === generation.current) setReadyUserId(syncingUserId);
      syncInFlight.current = null;
    });
    syncInFlight.current = run;
    return run;
  }, [pushSnapshot, userId]);

  React.useEffect(() => {
    if (session.isPending) return;
    generation.current++;
    if (!userId) {
      remoteHeads.current.clear();
      setReadyUserId(null);
      setConflicts([]);
      setError(null);
      setPhase("signed-out");
      return;
    }
    void runSync();
  }, [runSync, session.isPending, userId]);

  const keepLocal = React.useCallback(async (containerId: string): Promise<void> => {
    const bytes = await exportGameContainer(containerId);
    if (!bytes) throw new Error("No local save exists for this game");
    const latest = (await listRemoteSaves()).find((head) => head.containerId === containerId);
    if (latest) remoteHeads.current.set(containerId, latest);
    await pushSnapshot(containerId, bytes);
  }, [pushSnapshot]);

  const useCloud = React.useCallback(async (containerId: string): Promise<void> => {
    const bytes = await downloadRemoteSave(containerId);
    await importGameContainer(containerId, bytes, { replace: true });
    const head = (await listRemoteSaves()).find((item) => item.containerId === containerId);
    if (head) remoteHeads.current.set(containerId, head);
    const nextConflicts = conflicts.filter((item) => item.containerId !== containerId);
    setConflicts(nextConflicts);
    setPhase(nextConflicts.length > 0 ? "conflict" : "synced");
  }, [conflicts]);

  const value = React.useMemo<CloudSaveContextValue>(() => ({
    user: user ? { id: user.id, name: user.name, email: user.email, image: user.image } : null,
    sessionPending: session.isPending,
    ready: !session.isPending && (!user || (readyUserId === user.id && phase !== "checking")),
    phase,
    error,
    conflicts,
    refetchSession: async () => { await session.refetch(); },
    syncNow: runSync,
    pushSnapshot,
    keepLocal,
    useCloud,
  }), [conflicts, error, keepLocal, phase, pushSnapshot, readyUserId, runSync, session, useCloud, user]);

  return <CloudSaveContext.Provider value={value}>{children}</CloudSaveContext.Provider>;
}

export function useCloudSaves(): CloudSaveContextValue {
  const value = React.useContext(CloudSaveContext);
  if (!value) throw new Error("useCloudSaves must be used inside CloudSaveProvider");
  return value;
}
