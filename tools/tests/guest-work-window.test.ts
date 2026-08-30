import { describe, expect, test, beforeEach } from 'bun:test';
import {
    armGuestWorkWindow,
    cancelGuestWorkWindow,
    isGuestWorkWindowArmed,
    readGuestOdometer,
    readGuestWorkWindow,
    resetGuestOdometer,
    resetGuestWorkTracking,
    sampleGuestWorkCounter,
} from '../../src/worker/core/debug/guest-work-window';

describe('guest work window', () => {
    beforeEach(() => {
        resetGuestWorkTracking();
    });

    test('first sample only primes, it does not count', () => {
        sampleGuestWorkCounter(5_000, 0);
        expect(readGuestOdometer().instructions).toBe(0);
        sampleGuestWorkCounter(6_000, 1);
        expect(readGuestOdometer().instructions).toBe(1_000);
    });

    test('odometer accumulates across the u32 wrap of instruction_counter', () => {
        // v86's instruction_counter is a u32 that wraps every ~4.29e9 instructions.
        // A round trip straddling the wrap must contribute its true delta, not a
        // huge negative jump nor a reset to zero.
        sampleGuestWorkCounter(0xffff_ff00, 0);
        sampleGuestWorkCounter(0x0000_0100, 1); // wrapped: true delta is 0x200
        expect(readGuestOdometer().instructions).toBe(0x200);

        sampleGuestWorkCounter(0x0000_0300, 2);
        expect(readGuestOdometer().instructions).toBe(0x400);
    });

    test('a fixed-work window closes exactly when the target is reached', () => {
        sampleGuestWorkCounter(0, 0);
        armGuestWorkWindow(1_000, 10);
        expect(isGuestWorkWindowArmed()).toBe(true);

        sampleGuestWorkCounter(400, 20);
        expect(isGuestWorkWindowArmed()).toBe(true);
        expect(readGuestWorkWindow(20).done).toBe(false);

        sampleGuestWorkCounter(1_100, 30);
        expect(isGuestWorkWindowArmed()).toBe(false);

        const report = readGuestWorkWindow(999);
        expect(report.done).toBe(true);
        expect(report.instructions).toBe(1_100);
        // Wall time is frozen at the closing sample, not at read time: a late
        // readout must not inflate the measured duration.
        expect(report.wallMs).toBe(20);
        expect(report.ticks).toBe(2);
    });

    test('MIPS is retired guest instructions per wall millisecond, in millions', () => {
        sampleGuestWorkCounter(0, 0);
        armGuestWorkWindow(50_000_000, 0);
        // 50e6 instructions in 1000 ms => 50 MIPS.
        sampleGuestWorkCounter(50_000_000, 1_000);
        expect(readGuestWorkWindow(1_000).mips).toBeCloseTo(50, 3);
    });

    test('a closed window stops accumulating', () => {
        sampleGuestWorkCounter(0, 0);
        armGuestWorkWindow(100, 0);
        sampleGuestWorkCounter(100, 10);
        sampleGuestWorkCounter(10_000, 20);
        const report = readGuestWorkWindow(20);
        expect(report.instructions).toBe(100);
        // The odometer keeps running even though the window is closed.
        expect(readGuestOdometer().instructions).toBe(10_000);
    });

    test('cancel abandons an in-flight window without recording a result', () => {
        sampleGuestWorkCounter(0, 0);
        armGuestWorkWindow(1_000, 0);
        sampleGuestWorkCounter(500, 5);
        cancelGuestWorkWindow();
        const report = readGuestWorkWindow(10);
        expect(report.armed).toBe(false);
        expect(report.done).toBe(false);
        expect(report.instructions).toBe(0);
    });

    test('odometer reset returns the phase that just ended and starts a new one', () => {
        sampleGuestWorkCounter(0, 0);
        sampleGuestWorkCounter(7_000, 1);
        const previous = resetGuestOdometer();
        expect(previous.instructions).toBe(7_000);
        expect(readGuestOdometer().instructions).toBe(0);

        // Accumulation continues from the live counter, with no phantom delta from
        // the reset itself.
        sampleGuestWorkCounter(7_500, 2);
        expect(readGuestOdometer().instructions).toBe(500);
    });

    test('tracking reset drops the primed counter so a new v86 does not inject a jump', () => {
        sampleGuestWorkCounter(4_000_000, 0);
        sampleGuestWorkCounter(4_000_100, 1);
        expect(readGuestOdometer().instructions).toBe(100);

        resetGuestWorkTracking();
        // A recreated v86 restarts its counter near zero. Without re-priming, the
        // delta would be read as a ~4.29e9 wrap.
        sampleGuestWorkCounter(12, 2);
        sampleGuestWorkCounter(112, 3);
        expect(readGuestOdometer().instructions).toBe(100);
    });
});
