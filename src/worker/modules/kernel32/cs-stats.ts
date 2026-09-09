/** LeaveCriticalSection branch counters (fast path / ordinary thunk), read by dbg.csWakeStats.
 *  Dependency-free so the debug commands can import them without a module cycle. */
export const csLeaveFastStats = { calls: 0, nonOwner: 0, recursive: 0, staleSem: 0, waiters: 0, deferred: 0, declined: 0, released: 0 };
export const csLeaveSlowStats = { calls: 0, recursive: 0, waiters: 0, deferred: 0, free: 0 };
