import type { HookedFunction } from './types';

/** Decide whether detection should proceed to a guest-code patch. */
export function shouldInstallHook(
    declaration: HookedFunction,
    functionName: string,
    disabledFunctions: ReadonlySet<string>,
    enabledFunctions: ReadonlySet<string>,
): boolean {
    if (disabledFunctions.has(functionName)) return false;
    return declaration.enabledByDefault !== false || enabledFunctions.has(functionName);
}
