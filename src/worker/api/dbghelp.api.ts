import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

const makeFunc = (name: string, argCount: number, overrides: Partial<FunctionDescriptor> = {}): FunctionDescriptor => ({
    name,
    params: overrides.params ?? buildParams(argCount),
    returnType: overrides.returnType ?? "u32",
    callingConvention: overrides.callingConvention ?? "stdcall",
});

export const dbghelpModule: ModuleDescriptor = {
    name: "dbghelp",
    functions: [
        makeFunc("SymInitialize", 3),
        makeFunc("SymCleanup", 1),
        makeFunc("SymSetOptions", 1),
        makeFunc("SymGetOptions", 0),
        makeFunc("SymGetModuleBase", 2),
        makeFunc("SymGetModuleBase64", 2),
        makeFunc("SymLoadModule", 6),
        makeFunc("SymFunctionTableAccess", 2),
        makeFunc("SymFunctionTableAccess64", 2),
        makeFunc("SymGetLineFromAddr", 4),
        makeFunc("SymGetSymFromAddr", 4),
        makeFunc("StackWalk", 9),
        makeFunc("StackWalk64", 9),
    ],
};
