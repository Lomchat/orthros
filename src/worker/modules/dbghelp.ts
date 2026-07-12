import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../core/logger";

export class DbgHelp implements IModule {
    name = "dbghelp";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {}

    constructor(_process: Process) {
        const exports = this.exports;

        // BOOL SymInitialize(HANDLE hProcess, PCSTR UserSearchPath, BOOL fInvadeProcess)
        exports['SymInitialize'] = () => 1; // TRUE

        // BOOL SymCleanup(HANDLE hProcess)
        exports['SymCleanup'] = () => 1;

        // DWORD SymSetOptions(DWORD SymOptions)
        exports['SymSetOptions'] = (_ctx, _mem, args) => args[0] >>> 0;

        // DWORD SymGetOptions(void)
        exports['SymGetOptions'] = () => 0;

        // DWORD SymGetModuleBase(HANDLE hProcess, DWORD dwAddr)
        exports['SymGetModuleBase'] = () => 0;

        // DWORD64 SymGetModuleBase64(HANDLE hProcess, DWORD64 dwAddr)
        exports['SymGetModuleBase64'] = () => 0;

        // DWORD SymLoadModule(HANDLE, HANDLE, PCSTR, PCSTR, DWORD, DWORD)
        exports['SymLoadModule'] = () => 0;

        // PVOID SymFunctionTableAccess(HANDLE hProcess, DWORD AddrBase)
        exports['SymFunctionTableAccess'] = () => 0;

        // PVOID SymFunctionTableAccess64(HANDLE hProcess, DWORD64 AddrBase)
        exports['SymFunctionTableAccess64'] = () => 0;

        // BOOL SymGetLineFromAddr(HANDLE, DWORD, PDWORD, PIMAGEHLP_LINE)
        exports['SymGetLineFromAddr'] = () => 0; // FALSE

        // BOOL SymGetSymFromAddr(HANDLE, DWORD, PDWORD, PIMAGEHLP_SYMBOL)
        exports['SymGetSymFromAddr'] = () => 0; // FALSE

        // BOOL StackWalk(DWORD, HANDLE, HANDLE, LPSTACKFRAME, PVOID, PREAD_PROCESS_MEMORY_ROUTINE, PFUNCTION_TABLE_ACCESS_ROUTINE, PGET_MODULE_BASE_ROUTINE, PTRANSLATE_ADDRESS_ROUTINE)
        exports['StackWalk'] = () => 0; // FALSE — no frames

        // BOOL StackWalk64(DWORD, HANDLE, HANDLE, LPSTACKFRAME64, PVOID, PREAD_PROCESS_MEMORY_ROUTINE64, PFUNCTION_TABLE_ACCESS_ROUTINE64, PGET_MODULE_BASE_ROUTINE64, PTRANSLATE_ADDRESS_ROUTINE64)
        exports['StackWalk64'] = () => 0; // FALSE — no frames
    }
}
