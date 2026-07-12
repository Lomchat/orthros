/**
 * SHFOLDER.dll API descriptor.
 * shfolder.dll is a thin forwarder to shell32:SHGetFolderPath on modern Windows.
 * Games that LoadLibrary("shfolder.dll") + GetProcAddress("SHGetFolderPathA")
 * need this module to exist so the dynamic load succeeds.
 */

import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

const makeFunc = (name: string, argCount: number): FunctionDescriptor => ({
    name,
    params: buildParams(argCount),
    returnType: "u32",
    callingConvention: "stdcall",
});

export const shfolderModule: ModuleDescriptor = {
    name: "shfolder",
    functions: [
        // HRESULT SHGetFolderPathA(HWND hwnd, int csidl, HANDLE hToken, DWORD dwFlags, LPSTR pszPath)
        makeFunc("SHGetFolderPathA", 5),
        // HRESULT SHGetFolderPathW(HWND hwnd, int csidl, HANDLE hToken, DWORD dwFlags, LPWSTR pszPath)
        makeFunc("SHGetFolderPathW", 5),
    ],
};
