import { msvcrtModule } from "./msvcrt.api";
import { ModuleDescriptor, FunctionDescriptor } from "./types";

const buildParams = (count: number) => {
    const params = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" as const });
    }
    return params;
};

/** VC9 C++ frame handler — same 4-arg layout as __CxxFrameHandler for bring-up. */
const vc9Extras: FunctionDescriptor[] = [
    {
        name: "__CxxFrameHandler3",
        params: buildParams(4),
        returnType: "u32",
        callingConvention: "cdecl",
    },
    {
        name: "__CppXcptFilter",
        params: buildParams(2),
        returnType: "u32",
        callingConvention: "cdecl",
    },
    {
        name: "__clean_type_info_names_internal",
        params: buildParams(0),
        returnType: "void",
        callingConvention: "cdecl",
    },
    {
        name: "_malloc_crt",
        params: buildParams(1),
        returnType: "u32",
        callingConvention: "cdecl",
    },
];

export const msvcr90Module: ModuleDescriptor = {
    name: "msvcr90",
    functions: [...msvcrtModule.functions, ...vc9Extras],
};
