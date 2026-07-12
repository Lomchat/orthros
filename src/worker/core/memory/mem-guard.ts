import { Logger, LogCategory } from "../logger";
import { System } from "../system";
import { reportMemoryFault } from "./memory-fault";
import type { RegionEntry } from "./address-space";

import { Mem } from "./mem-accessor";

type GuardMode = "clamp" | "warn" | "throw";

export class MemoryGuard {
    // Toggle to enable/disable bounds checks and clamping.
    static enabled = true;
    static mode: GuardMode = "clamp";

    static writeBytes(mem: Uint8Array, address: number, data: Uint8Array, label: string): number {
        // H1 Stack: Log all writes through MemoryGuard to stack region
        if (address >= 0x80000 && address < 0x100000) {
            (Mem as any).logStackWrite(address, data.length, data);
        }

        // OPTIMIZED: Removed memoryWatch diagnostics from hot path
        if (!this.enabled) {
            mem.set(data, address);
            return data.length;
        }

        const absoluteAddress = address + mem.byteOffset;
        const writeSize = data.length;

        if (!this.isValidRange(mem, address, 1)) {
            reportMemoryFault({
                address: absoluteAddress,
                size: writeSize,
                perms: "rw",
                accessType: "write",
                context: "MemoryGuard.writeBytes",
                reason: "Write out of bounds before thunk guard",
            });
            return 0;
        }

        // Check if write would overlap protected regions (thunk/callback/spin)
        // This prevents games from writing to system code regions via direct memory access
        const process = System.getInstance().process;
        let regions = null;
        try {
            regions = process?.thunkMemoryManager?.getRegions() ?? null;
        } catch {}
        if (regions) {
            const end = absoluteAddress + writeSize;
            const thunkEnd = regions.thunkGeneratorBase + regions.thunkGeneratorSize;
            const isInsideThunk = absoluteAddress >= regions.thunkGeneratorBase && absoluteAddress < thunkEnd;
            const overlapsThunk = absoluteAddress < thunkEnd && end > regions.thunkGeneratorBase;
            if (isInsideThunk || overlapsThunk) {
                const thunkRegion: RegionEntry = {
                    id: 0,
                    base: regions.thunkGeneratorBase,
                    size: regions.thunkGeneratorSize,
                    perms: "rx",
                    kind: "THUNK_CODE",
                    owner: "MemoryGuard",
                };
                reportMemoryFault({
                    address: absoluteAddress,
                    size: writeSize,
                    perms: "rx",
                    region: thunkRegion,
                    accessType: "write",
                    context: "MemoryGuard.writeBytes",
                    reason: "Direct thunk region write detected",
                });
                return 0; // ABORT write
            }
        }

        const maxWrite = Math.max(0, mem.length - address);
        const writeLen = Math.min(data.length, maxWrite);

        if (writeLen > 0) {
            mem.set(data.subarray(0, writeLen), address);
        }

        return writeLen;
    }

    static writeUint32(mem: Uint8Array, view: DataView, address: number, value: number, label: string): boolean {
        // H1 Stack: Log all writes through MemoryGuard to stack region
        if (address >= 0x80000 && address < 0x100000) {
            (Mem as any).logStackWrite(address, 4, value);
        }

        if (!this.enabled) {
            view.setUint32(address, value >>> 0, true);
            return true;
        }

        if (!this.isValidRange(mem, address, 4)) {
            this.handleInvalid(label, address, 4, mem.length);
            return false;
        }

        view.setUint32(address, value >>> 0, true);
        return true;
    }

    static readBytes(mem: Uint8Array, address: number, size: number, label: string): Uint8Array | null {
        if (!this.enabled) {
            return mem.subarray(address, address + size);
        }
        if (!this.isValidRange(mem, address, size)) {
            this.handleInvalid(label, address, size, mem.length);
            const maxRead = Math.max(0, mem.length - Math.max(0, address));
            return maxRead > 0 ? mem.subarray(Math.max(0, address), Math.max(0, address) + maxRead) : null;
        }
        return mem.subarray(address, address + size);
    }

    static readUint32(mem: Uint8Array, view: DataView, address: number, label: string): number | null {
        if (!this.enabled) return view.getUint32(address, true);
        if (!this.isValidRange(mem, address, 4)) {
            this.handleInvalid(label, address, 4, mem.length);
            return null;
        }
        return view.getUint32(address, true);
    }

    static checkStackWrite(mem: Uint8Array, newEsp: number, bytes: number, label: string): boolean {
        if (!this.enabled) return true;
        if (!this.isValidRange(mem, newEsp, bytes)) {
            this.warn(label, `stack write out of bounds: esp=0x${newEsp.toString(16)} bytes=${bytes} mem=0x${mem.length.toString(16)}`);
            if (this.mode === "throw") throw new Error(`${label}: stack write out of bounds`);
            return false;
        }
        return true;
    }

    static isValidRange(mem: Uint8Array, address: number, size: number): boolean {
        if (address < 0 || size < 0) return false;
        return address + size <= mem.length;
    }

    private static handleInvalid(label: string, address: number, size: number, memSize: number): number {
        const msg = `${label}: invalid address 0x${address.toString(16)} size=${size} (mem size=0x${memSize.toString(16)})`;
        this.warn(label, msg);
        if (this.mode === "throw") {
            throw new Error(msg);
        }
        return 0;
    }

    private static warn(label: string, message: string): void {
        Logger.warn(LogCategory.SYSTEM, `${label}: ${message}`);
    }
}
