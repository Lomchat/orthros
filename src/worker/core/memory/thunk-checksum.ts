/**
 * Thunk Checksum Manager - Software Page Protection
 *
 * JavaScript doesn't support hardware page protection (no MMU access).
 * This module uses SHA-256 checksums to detect unauthorized writes to THUNK_CODE regions.
 *
 * Strategy: Store checksums at initialization, validate at safe points
 * (Unlock, Blt, Flip, thunk return).
 */

import { Logger, LogCategory } from '../logger';
import { reportMemoryFault } from './memory-fault';
import { asBufferSource } from '../../../dom-buffer';

interface PageChecksum {
    base: number;
    size: number;
    checksum: string; // SHA-256 hex
}

export class ThunkChecksumManager {
    private checksums: Map<number, PageChecksum> = new Map();
    private isInitialized = false;

    async initializeThunkRegion(mem: Uint8Array, base: number, size: number): Promise<void> {
        const PAGE_SIZE = 0x1000;
        const pageCount = Math.ceil(size / PAGE_SIZE);

        this.checksums.clear();

        for (let i = 0; i < pageCount; i++) {
            const pageBase = base + i * PAGE_SIZE;
            const pageSize = Math.min(PAGE_SIZE, size - i * PAGE_SIZE);
            const pageData = mem.slice(pageBase, pageBase + pageSize);
            const checksum = await this.computeSHA256(pageData);
            this.checksums.set(pageBase, { base: pageBase, size: pageSize, checksum });
        }

        this.isInitialized = true;

        Logger.log(LogCategory.SYSTEM,
            `ThunkChecksumManager: initialized ${pageCount} pages at 0x${base.toString(16)} ` +
            `(size=0x${size.toString(16)})`);
    }

    private lastValidationTime = 0;
    private validationInterval = 1000; // Only validate once per second to avoid lag

    async validateThunkRegion(mem: Uint8Array, context: string): Promise<boolean> {
        if (!this.isInitialized || this.checksums.size === 0) {
            // No checksums initialized yet, skip validation
            return true;
        }

        // Rate limiting: don't validate too frequently (causes lag)
        const now = performance.now();
        if (now - this.lastValidationTime < this.validationInterval) {
            return true; // Skip validation, too soon
        }
        this.lastValidationTime = now;

        for (const [pageBase, stored] of this.checksums.entries()) {
            const pageData = mem.slice(pageBase, pageBase + stored.size);
            const currentChecksum = await this.computeSHA256(pageData);

            if (currentChecksum !== stored.checksum) {
                Logger.error(LogCategory.SYSTEM,
                    `🚨 THUNK_CODE corruption detected at 0x${pageBase.toString(16)} ` +
                    `(expected: ${stored.checksum.slice(0, 16)}..., got: ${currentChecksum.slice(0, 16)}...)`);

                reportMemoryFault({
                    address: pageBase,
                    size: stored.size,
                    perms: "rx",
                    accessType: "write",
                    context: `ThunkChecksum validation in ${context}`,
                    reason: `THUNK_CODE modified (checksum mismatch) - stored: ${stored.checksum.slice(0, 16)}..., current: ${currentChecksum.slice(0, 16)}...`,
                });

                return false;
            }
        }

        return true;
    }

    private async computeSHA256(data: Uint8Array): Promise<string> {
        // Use Web Crypto API for fast SHA-256 computation (~1-2ms for 16KB)
        const hashBuffer = await crypto.subtle.digest("SHA-256", asBufferSource(data));
        return Array.from(new Uint8Array(hashBuffer))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
    }

    getStats(): { pageCount: number; totalSize: number } {
        let totalSize = 0;
        for (const checksum of this.checksums.values()) {
            totalSize += checksum.size;
        }
        return {
            pageCount: this.checksums.size,
            totalSize,
        };
    }
}

export const thunkChecksumManager = new ThunkChecksumManager();
