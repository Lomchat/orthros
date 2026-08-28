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
        // BOOL EnumProcesses(DWORD *lpidProcess, DWORD cb, DWORD *lpcbNeeded)
        // There is one emulated Win32 process in a worker.
        this.exports["EnumProcesses"] = (ctx, mem, args) => {
            const out = args[0] >>> 0;
            const cb = args[1] >>> 0;
            const needed = args[2] >>> 0;
            if (!needed || needed + 4 > mem.length) {
                return { value: 0, stackCleanup: 12 };
            }
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const wrote = out !== 0 && cb >= 4 && out + 4 <= mem.length;
            if (wrote) view.setUint32(out, 1, true);
            view.setUint32(needed, wrote ? 4 : 0, true);
            return { value: 1, stackCleanup: 12 };
        };

        // BOOL EnumProcessModules(HANDLE hProcess, HMODULE *lphModule,
        //                         DWORD cb, LPDWORD lpcbNeeded)
        // Orthros exposes the main image plus loaded PE modules. The first entry
        // is sufficient for callers such as the EA crash/debug bootstrap, but
        // report the complete byte count so a caller can retry with a larger
        // buffer without receiving fabricated handles.
        this.exports["EnumProcessModules"] = (ctx, mem, args) => {
            const lphModule = args[1] >>> 0;
            const cb = args[2] >>> 0;
            const lpcbNeeded = args[3] >>> 0;
            if (!lpcbNeeded || lpcbNeeded + 4 > mem.length) {
                return { value: 0, stackCleanup: 16 };
            }

            const modules = [...process.moduleRegistry.getAllModules()]
                .map((module: any) => module.baseAddress >>> 0)
                .filter((base: number) => base !== 0);
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            view.setUint32(lpcbNeeded, modules.length * 4, true);
            if (lphModule && lphModule < mem.length) {
                const count = Math.min(modules.length, cb >>> 2, (mem.length - lphModule) >>> 2);
                for (let i = 0; i < count; i++) {
                    view.setUint32(lphModule + i * 4, modules[i]!, true);
                }
            }
            return { value: 1, stackCleanup: 16 };
        };

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

        // DWORD GetModuleBaseNameA(HANDLE, HMODULE, LPSTR, DWORD)
        this.exports["GetModuleBaseNameA"] = (ctx, mem, args) => {
            const hModule = args[1] >>> 0;
            const out = args[2] >>> 0;
            const capacity = args[3] >>> 0;
            if (!out || capacity === 0 || out >= mem.length) {
                return { value: 0, stackCleanup: 16 };
            }
            const module = hModule
                ? process.moduleRegistry.getByBase(hModule)
                : process.moduleRegistry.getExecutableModule();
            const name = module?.name || "program.exe";
            const bytes = encodeAnsi(name);
            const count = Math.min(bytes.length, capacity - 1, mem.length - out - 1);
            mem.set(bytes.subarray(0, count), out);
            mem[out + count] = 0;
            return { value: count, stackCleanup: 16 };
        };
    }
}
