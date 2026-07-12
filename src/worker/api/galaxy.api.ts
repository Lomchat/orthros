import { ModuleDescriptor, FunctionDescriptor } from "./types";
import { GALAXY_HLE_ALL_EXPORTS } from "../modules/galaxy/export-names";
import { GALAXY_STACK_CLEANUP } from "../modules/galaxy/stack-cleanup";

function msvcFunc(name: string, stackCleanupBytes: number): FunctionDescriptor {
    return {
        name,
        params: [],
        returnType: "u32",
        callingConvention: "stdcall",
        stackCleanupBytes,
    };
}

const STACK = GALAXY_STACK_CLEANUP;

export const galaxyModule: ModuleDescriptor = {
    name: "galaxy",
    functions: GALAXY_HLE_ALL_EXPORTS.map((name) => msvcFunc(name, STACK[name] ?? 0)),
};
