export interface RemoteSaveHead {
  containerId: string;
  hash: string;
  size: number;
  deviceId: string;
  updatedAt: string;
}

export class CloudSaveConflictError extends Error {
  constructor(readonly remoteHash: string) {
    super("Cloud save changed since the last sync");
    this.name = "CloudSaveConflictError";
  }
}

export function cloudDeviceId(): string {
  const key = "orthros.cloud-device-id";
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(key, created);
    return created;
  } catch {
    return crypto.randomUUID();
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Use an exact ArrayBuffer slice: a Uint8Array may be a view into a larger backing buffer.
  const input = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", input as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  let payload: { error?: string; remoteHash?: string } = {};
  try { payload = await response.json(); } catch { /* non-JSON server failure */ }
  if (response.status === 409 && payload.remoteHash) throw new CloudSaveConflictError(payload.remoteHash);
  throw new Error(payload.error || `Cloud-save request failed (${response.status})`);
}

export async function listRemoteSaves(): Promise<RemoteSaveHead[]> {
  const response = await checked(await fetch("/api/saves", { credentials: "same-origin", cache: "no-store" }));
  const payload = await response.json() as { games?: RemoteSaveHead[] };
  return Array.isArray(payload.games) ? payload.games : [];
}

export async function downloadRemoteSave(containerId: string): Promise<Uint8Array> {
  const response = await checked(await fetch(`/api/saves/${encodeURIComponent(containerId)}`, {
    credentials: "same-origin",
    cache: "no-store",
  }));
  return new Uint8Array(await response.arrayBuffer());
}

export async function uploadRemoteSave(
  containerId: string,
  bytes: Uint8Array,
  parentHash: string,
  deviceId: string,
): Promise<{ hash: string; unchanged: boolean }> {
  const response = await checked(await fetch(`/api/saves/${encodeURIComponent(containerId)}`, {
    method: "PUT",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/zip",
      "X-Orthros-Parent-Hash": parentHash,
      "X-Orthros-Device-Id": deviceId,
    },
    body: bytes as unknown as BodyInit,
  }));
  return response.json() as Promise<{ hash: string; unchanged: boolean }>;
}

