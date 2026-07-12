import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Marshaler } from "../core/memory/marshaler";
import { Logger, LogCategory } from "../core/logger";
import { encodeAnsi } from "./codepage-utils";

export class Psapi implements IModule {
    name = "psapi";
    exports: Record<string, ThunkImplementation> = {};

    initialize(process: Process): void {
        // BOOL GetModuleInformation(HANDLE hProcess, HMODULE hModule, LPMODULEINFO lpmodinfo, DWORD cb)
        // MODULEINFO = { LPVOID lpBaseOfDll; DWORD SizeOfImage; LPVOID EntryPoint; } (12 bytes)
        this.exports["GetModuleInformation"] = (ctx, mem, args) => {
            const hModule = args[1];
            const lpmodinfo = args[2];
            const cb = args[3];

            if (!lpmodinfo || cb < 12) {
                return { value: 0, stackCleanup: 16 }; // FALSE
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpmodinfo, hModule >>> 0, true);     // lpBaseOfDll
            view.setUint32(lpmodinfo + 4, 0x10000, true);       // SizeOfImage (64K placeholder)
            view.setUint32(lpmodinfo + 8, hModule >>> 0, true); // EntryPoint
            return { value: 1, stackCleanup: 16 }; // TRUE
        };

        // DWORD GetModuleFileNameExA(HANDLE hProcess, HMODULE hModule, LPSTR lpFilename, DWORD nSize)
        this.exports["GetModuleFileNameExA"] = (ctx, mem, args) => {
            const lpFilename = args[2];
            const nSize = args[3];

            const name = "C:\\program.exe";
            if (!lpFilename || nSize === 0) {
                return { value: 0, stackCleanup: 16 };
            }

            const bytes = encodeAnsi(name + "\0");
            const toWrite = Math.min(bytes.length, nSize);
            mem.set(bytes.slice(0, toWrite), lpFilename);
            if (toWrite === nSize) mem[lpFilename + nSize - 1] = 0; // ensure null-term
            return { value: Math.min(name.length, nSize - 1), stackCleanup: 16 };
        };

        this.exports["GetModuleFileNameExW"] = (ctx, mem, args) => {
            const lpFilename = args[2];
            const nSize = args[3];

            const name = "C:\\program.exe";
            if (!lpFilename || nSize === 0) {
                return { value: 0, stackCleanup: 16 };
            }

            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const toWrite = Math.min(name.length, nSize - 1);
            for (let i = 0; i < toWrite; i++) {
                view.setUint16(lpFilename + i * 2, name.charCodeAt(i), true);
            }
            view.setUint16(lpFilename + toWrite * 2, 0, true);
            return { value: toWrite, stackCleanup: 16 };
        };
    }
}
