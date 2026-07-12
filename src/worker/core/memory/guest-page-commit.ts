import { System } from '../system';

type CommitNotifier = (addr: number, sizeBytes: number) => void;
let commitNotifier: CommitNotifier | null = null;

/** kernel32 registers this so VirtualQuery sees MEM_COMMIT after implicit recommit. */
export function registerGuestCommitNotifier(fn: CommitNotifier): void {
    commitNotifier = fn;
}

/**
 * Re-commit guest PTEs after MemoryManager hands out a HEAP address.
 * VirtualFree(MEM_DECOMMIT) clears the Present bit without freeing the
 * MemoryManager block; JS mem.fill still works but guest reads #PF until
 * pages are recommitted (Quake2 dsound buffer at ~0x919xxxx).
 */
export function ensureGuestPagesCommitted(addr: number, sizeBytes: number): void {
    if (addr === 0 || sizeBytes <= 0) return;
    const ptm = System.getInstance().process?.pageTableManager;
    if (!ptm?.isPagingEnabled()) return;
    ptm.ensurePagesCommitted(addr, sizeBytes);
    commitNotifier?.(addr, sizeBytes);
}
