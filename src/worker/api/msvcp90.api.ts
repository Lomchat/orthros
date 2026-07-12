import { ModuleDescriptor, FunctionDescriptor, ParameterDescriptor } from "./types";

const buildParams = (count: number): ParameterDescriptor[] => {
    const params: ParameterDescriptor[] = [];
    for (let i = 0; i < count; i++) {
        params.push({ name: `arg${i}`, type: "u32" });
    }
    return params;
};

/** MSVC thiscall: callee RET N — use stdcall + stackCleanupBytes in stub generator. */
const makeThiscall = (
    name: string,
    stackCleanupBytes: number,
    overrides: Partial<FunctionDescriptor> = {},
): FunctionDescriptor => ({
    name,
    params: overrides.params ?? buildParams(stackCleanupBytes > 0 ? stackCleanupBytes / 4 : 0),
    returnType: overrides.returnType ?? "u32",
    callingConvention: "stdcall",
    stackCleanupBytes,
    ...overrides,
});

export const msvcp90Module: ModuleDescriptor = {
    name: "msvcp90",
    functions: [
        makeThiscall("??0?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE@XZ", 0),
        makeThiscall("??0?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE@PBD@Z", 4),
        makeThiscall("??0?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE@ABV01@@Z", 4),
        makeThiscall("??1?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE@XZ", 0),
        makeThiscall("??4?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAEAAV01@PBD@Z", 4),
        makeThiscall("??Y?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAEAAV01@PBD@Z", 4),
        makeThiscall("?begin@?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE?AV?$_String_iterator@DU?$char_traits@D@std@@V?$allocator@D@2@@2@XZ", 4),
        makeThiscall("?end@?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@QAE?AV?$_String_iterator@DU?$char_traits@D@std@@V?$allocator@D@2@@2@XZ", 4),
        makeThiscall("?allocate@?$allocator@D@std@@QAEPADI@Z", 4),
        makeThiscall("?deallocate@?$allocator@D@std@@QAEXPADI@Z", 8),
        makeThiscall("??$?MDU?$char_traits@D@std@@V?$allocator@D@1@@std@@YA_NABV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@0@0@Z", 0, {
            params: buildParams(2),
            returnType: "u32",
            callingConvention: "cdecl",
            stackCleanupBytes: 0,
        }),
    ],
};
