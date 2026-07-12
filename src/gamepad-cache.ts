/**
 * Host-side gamepad discovery cache.
 *
 * Browsers gate navigator.getGamepads() until a user gesture (and sometimes until
 * the first physical button press for pads connected before page load). The
 * gamepadconnected event and a rescan right after the user opens Settings (click)
 * let us show the controller UI immediately when we can.
 */

export type GamepadMeta = {
  id: string;
  mapping: string;
  index: number;
};

let cached: GamepadMeta | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

function metaFromPad(pad: Gamepad): GamepadMeta {
  return {
    id: pad.id || "Gamepad",
    mapping: pad.mapping || "standard",
    index: pad.index,
  };
}

/** Scan getGamepads(); returns true if a connected pad was found. */
export function rescanGamepads(): boolean {
  const pads = navigator.getGamepads?.() ?? [];
  const pad = pads.find((p) => p?.connected) ?? null;
  if (pad) {
    const next = metaFromPad(pad);
    const changed =
      !cached ||
      cached.index !== next.index ||
      cached.id !== next.id ||
      cached.mapping !== next.mapping;
    cached = next;
    if (changed) notify();
    return true;
  }
  return false;
}

export function getCachedGamepadMeta(): GamepadMeta | null {
  return cached;
}

export function subscribeGamepadCache(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Install window listeners once for the app lifetime. */
export function initGamepadCache(): () => void {
  const onConnect = (e: GamepadEvent) => {
    cached = metaFromPad(e.gamepad);
    notify();
    rescanGamepads();
  };

  const onDisconnect = (e: GamepadEvent) => {
    if (cached?.index === e.gamepad.index) cached = null;
    if (!rescanGamepads()) notify();
  };

  window.addEventListener("gamepadconnected", onConnect);
  window.addEventListener("gamepaddisconnected", onDisconnect);
  rescanGamepads();

  return () => {
    window.removeEventListener("gamepadconnected", onConnect);
    window.removeEventListener("gamepaddisconnected", onDisconnect);
    cached = null;
    listeners.clear();
  };
}

/** First connected pad from getGamepads(), or null. */
export function readLiveGamepad(): Gamepad | null {
  const pads = navigator.getGamepads?.() ?? [];
  return pads.find((p) => p?.connected) ?? null;
}
