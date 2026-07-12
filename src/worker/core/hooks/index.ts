/**
 * Universal guest hot-spot hook framework.
 *
 * Importing this barrel registers the worker-console helpers (hook-globals) as a
 * side effect. Concrete HookSpecs (e.g. galaxy output conversion) register
 * themselves at import time — add their imports below so they load with the
 * framework.
 */

export type {
    HookSpec,
    HookHandler,
    HookInvocation,
    HookOutputRegion,
    HookAbi,
    HookStats,
} from './types';
export { hookRegistry } from './hook-registry';

// Side effect: expose hookReport()/hookReset()/setHookEnabled()/setHookOracle()/hookList().
import './hook-globals';

// Concrete hooks register here at import time (commit 4 adds galaxy.outConvert):
// import './specs/galaxy-out-convert';
