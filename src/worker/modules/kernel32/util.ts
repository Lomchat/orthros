/**
 * Kernel32 Utility functions
 *
 * Mathematical and helper functions
 * Atomic implementation for utility operations
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { Logger, LogCategory } from '../../core/logger';

export const exports: Record<string, ThunkImplementation> = {
    // Legacy helper used by some allocators/loaders to detect NT-family Windows.
    // In our environment we emulate NT semantics, so return TRUE.
    'IsTNT': () => 1,

    /**
     * MulDiv - Multiplies two 32-bit values and then divides the 64-bit result by a third value
     * @param nNumber - Multiplicand
     * @param nNumerator - Multiplier
     * @param nDenominator - Divisor
     * @returns Result of (nNumber * nNumerator) / nDenominator, rounded to nearest integer
     */
    'MulDiv': (ctx, mem, args) => {
        const nNumber = args[0] | 0; // Signed 32-bit
        const nNumerator = args[1] | 0;
        const nDenominator = args[2] | 0;

        if (nDenominator === 0) {
            Logger.warn(LogCategory.KERNEL32, 'MulDiv: Division by zero');
            return -1; // ERROR
        }

        // Use BigInt for 64-bit intermediate result to avoid overflow
        const result = (BigInt(nNumber) * BigInt(nNumerator)) / BigInt(nDenominator);

        // Check for overflow
        if (result > 0x7FFFFFFFn || result < -0x80000000n) {
            Logger.warn(LogCategory.KERNEL32, `MulDiv: Result overflow (${result})`);
            return -1; // ERROR
        }

        const finalResult = Number(result);

        return finalResult | 0; // Return as signed 32-bit
    },
};
