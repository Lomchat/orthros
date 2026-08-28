/**
 * Bounded recorder for guest MessageBox calls. Games commonly explain a
 * deliberate ExitProcess(1) in a dialog immediately before shutting down.
 * Recording only happens when a dialog is shown, so there is no frame-loop cost.
 */

export interface GuestMessageBoxRecord {
    kind: "MessageBoxA" | "MessageBoxW" | "MessageBoxIndirectA" | "MessageBoxIndirectW";
    caption: string;
    text: string;
    style: number;
    eip: number;
}

const MAX_RECORDS = 8;
let records: GuestMessageBoxRecord[] = [];

export function recordGuestMessageBox(record: GuestMessageBoxRecord): void {
    records.push({
        ...record,
        caption: record.caption.slice(0, 1024),
        text: record.text.slice(0, 8192),
        style: record.style >>> 0,
        eip: record.eip >>> 0,
    });
    if (records.length > MAX_RECORDS) records = records.slice(-MAX_RECORDS);
}

export function getGuestMessageBoxes(): GuestMessageBoxRecord[] {
    return records.map((record) => ({ ...record }));
}

export function resetGuestMessageBoxes(): void {
    records = [];
}
