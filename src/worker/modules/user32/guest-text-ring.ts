/**
 * The last strings the guest formatted or set on windows: an engine's own
 * assertion or crash dialog is built with wsprintf and pushed into controls
 * before anything shows it, and it is readable from the Worker's own CDP
 * session while the page is blocked by that very dialog. Pure hex words (a
 * stack dump) are dropped so they cannot flood the ring.
 */
const RING = 200;

export function noteGuestText(kind: string, text: string): void {
    if (!text || /^[0-9a-fA-F]{8}$/.test(text)) return;
    const g = globalThis as unknown as { __guestRecentText?: string[] };
    const ring = (g.__guestRecentText ??= []);
    ring.push(`${kind}: ${text.slice(0, 400)}`);
    if (ring.length > RING) ring.shift();
}

export function recentGuestText(): string[] {
    return (((globalThis as unknown as { __guestRecentText?: string[] }).__guestRecentText) ?? []).slice();
}
