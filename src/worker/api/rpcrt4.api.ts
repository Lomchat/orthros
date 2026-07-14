/**
 * RPC Runtime (rpcrt4.dll) API Descriptor
 *
 * UUID/string helpers from rpcdce.h. All RPC_ENTRY (__stdcall).
 * Arg counts mirror tools/reference/win32/rpcrt4/rpcrt4.sig.json.
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

export const rpcrt4Module: ModuleDescriptor = {
    name: "rpcrt4",
    functions: [
        makeFunc("UuidCreate", 1),             // UUID *Uuid
        makeFunc("UuidCreateSequential", 1),   // UUID *Uuid
        makeFunc("UuidCreateNil", 1),          // UUID *Nil
        makeFunc("UuidToStringA", 2),          // const UUID *, RPC_CSTR *
        makeFunc("UuidToStringW", 2),          // const UUID *, RPC_WSTR *
        makeFunc("UuidFromStringA", 2),        // RPC_CSTR, UUID *
        makeFunc("UuidFromStringW", 2),        // RPC_WSTR, UUID *
        makeFunc("UuidCompare", 3),            // UUID *, UUID *, RPC_STATUS *
        makeFunc("UuidEqual", 3),              // UUID *, UUID *, RPC_STATUS *
        makeFunc("UuidHash", 2),               // UUID *, RPC_STATUS *
        makeFunc("UuidIsNil", 2),              // UUID *, RPC_STATUS *
        makeFunc("RpcStringFreeA", 1),         // RPC_CSTR *
        makeFunc("RpcStringFreeW", 1),         // RPC_WSTR *
    ],
};
