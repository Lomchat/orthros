/**
 * Dialog bridge: links worker MessageBox requests to host UI (postMessage).
 * Host shows native alert/confirm and posts message_box_result; we resolve the Promise.
 */

import { harnessBus } from "../harness/event-bus";

let nextId = 0;
const pending = new Map<number, (result: number) => void>();

export function requestMessageBox(text: string, caption: string, uType: number): Promise<number> {
    const id = ++nextId;
    return new Promise((resolve) => {
        pending.set(id, resolve);
        self.postMessage({ type: "show_message_box", id, text, caption, uType });
        // Harness modalShown event — lets unattended runs auto-answer.
        harnessBus.emit("modalShown", { id, text, caption, uType });
    });
}

export function resolveMessageBox(id: number, result: number): void {
    const resolve = pending.get(id);
    if (resolve) {
        pending.delete(id);
        resolve(result);
    }
}
