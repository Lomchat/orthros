/**
 * Vista+ kernel32 exports commonly resolved via GetProcAddress (CRT / modern runtimes).
 */

import { ThunkImplementation } from '../../core/thunking/thunk-dispatcher';
import { System } from '../../core/system';
import { Mem } from '../../core/memory/mem-accessor';
import { TimeService } from '../../runtime/time';
import { TimerKind } from '../../core/scheduler/types';
import { Logger, LogCategory } from '../../core/logger';
import { resetSrwLock } from './srw-lock';

const INIT_ONCE_INITIALIZED = 1;

interface TpTimer {
    callback: number;
    context: number;
    wheelId: number | null;
}

interface TpWork {
    callback: number;
    context: number;
}

const tpTimers = new Map<number, TpTimer>();
const tpWaits = new Set<number>();
const tpWork = new Map<number, TpWork>();
let nextTpHandle = 0x00080000;

function initVistaRuntime(): Record<string, ThunkImplementation> {
    const exports: Record<string, ThunkImplementation> = {};

    exports['InitOnceExecuteOnce'] = (ctx, mem, args) => {
        const lpInitOnce = args[0] >>> 0;
        const pfnInitFn = args[1] >>> 0;
        const parameter = args[2] >>> 0;
        const context = args[3] >>> 0;

        if (!lpInitOnce) {
            System.getInstance().scheduler.setLastError(87);
            return 0;
        }

        const state = Mem.readUint32(lpInitOnce) ?? 0;
        if (state === INIT_ONCE_INITIALIZED) {
            return 1;
        }

        if (!pfnInitFn) {
            Mem.writeUint32(lpInitOnce, INIT_ONCE_INITIALIZED);
            return 1;
        }

        const process = System.getInstance().process;
        const callbackManager = process?.dispatcher?.callbackManager;
        if (!callbackManager) {
            Mem.writeUint32(lpInitOnce, INIT_ONCE_INITIALIZED);
            return 1;
        }

        const STACK_CLEANUP = 16;
        callbackManager.saveSuspendedThunkContext(ctx, STACK_CLEANUP);

        let contextPtr = context;
        if (!contextPtr && process?.memory) {
            contextPtr = process.memory.alloc(4);
            Mem.writeUint32(contextPtr, 0);
        }

        const { callbackId } = callbackManager.invokeCallback(
            pfnInitFn,
            [lpInitOnce, parameter, contextPtr],
            12,
            (ret) => {
                if (ret) Mem.writeUint32(lpInitOnce, INIT_ONCE_INITIALIZED);
                return ret ? 1 : 0;
            },
            false,
            'InitOnceExecuteOnce',
        );

        return { value: 0, suspendedForCallback: true, callbackId, stackCleanup: STACK_CLEANUP };
    };

    exports['InitializeConditionVariable'] = (_ctx, _mem, args) => {
        const cv = args[0] >>> 0;
        if (cv) Mem.writeUint32(cv, 0);
        return 0;
    };

    // SleepConditionVariableCS lives in kernel32/sync.ts alongside the CS + CV machinery.

    exports['InitializeSRWLock'] = (_ctx, _mem, args) => {
        resetSrwLock(args[0] >>> 0);
        return 0;
    };

    exports['FlushProcessWriteBuffers'] = () => 0;

    exports['FreeLibraryWhenCallbackReturns'] = () => 0;

    exports['GetCurrentProcessorNumber'] = () => 0;

    exports['GetCurrentPackageId'] = (_ctx, _mem, args) => {
        const APPMODEL_ERROR_NO_PACKAGE = 15700;
        const bufferLength = args[0] >>> 0;
        if (bufferLength) Mem.writeUint32(bufferLength, 0);
        System.getInstance().scheduler.setLastError(APPMODEL_ERROR_NO_PACKAGE);
        return APPMODEL_ERROR_NO_PACKAGE;
    };

    exports['CreateThreadpoolTimer'] = (_ctx, _mem, args) => {
        const handle = nextTpHandle++;
        tpTimers.set(handle, { callback: args[0] >>> 0, context: args[1] >>> 0, wheelId: null });
        System.getInstance().scheduler.ensureTimerPumpThread();
        return handle;
    };

    exports['SetThreadpoolTimer'] = (_ctx, _mem, args) => {
        const handle = args[0] >>> 0;
        const pftDueTime = args[1] >>> 0;
        const msPeriod = args[2] >>> 0;
        const entry = tpTimers.get(handle);
        if (!entry) return 0;

        const scheduler = System.getInstance().scheduler;
        const wheel = scheduler.timerWheel;
        if (entry.wheelId !== null) {
            wheel.cancel(entry.wheelId);
            entry.wheelId = null;
        }

        if (!pftDueTime && msPeriod === 0) {
            return 0;
        }

        let delayMs = 1;
        if (pftDueTime) {
            const low = Mem.readUint32(pftDueTime) ?? 0;
            const high = Mem.readUint32(pftDueTime + 4) ?? 0;
            if ((high | 0) < 0) {
                const due100ns = (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0);
                const abs100ns = due100ns < 0n ? -due100ns : due100ns;
                delayMs = Number(abs100ns / 10000n);
            }
        } else if (msPeriod > 0) {
            delayMs = msPeriod;
        }

        const fire = () => {
            const timer = tpTimers.get(handle);
            if (!timer || !timer.callback) return;
            // PTP_TIMER_CALLBACK(PTP_CALLBACK_INSTANCE Instance, PVOID Context, PTP_TIMER Timer).
            System.getInstance().scheduler.postTimerCallback(timer.callback, [0, timer.context, handle]);
        };

        entry.wheelId = wheel.add(
            Math.max(1, delayMs),
            msPeriod > 0,
            TimerKind.WAITABLE_TIMER,
            fire,
            TimeService.getInstance().nowMs(),
        );
        return 0;
    };

    exports['WaitForThreadpoolTimerCallbacks'] = () => 0;

    exports['CloseThreadpoolTimer'] = (_ctx, _mem, args) => {
        const handle = args[0] >>> 0;
        const entry = tpTimers.get(handle);
        if (entry?.wheelId !== null && entry?.wheelId !== undefined) {
            System.getInstance().scheduler.timerWheel.cancel(entry.wheelId);
        }
        tpTimers.delete(handle);
        return 0;
    };

    exports['CreateThreadpoolWait'] = (_ctx, _mem, args) => {
        const handle = nextTpHandle++;
        tpWaits.add(handle);
        return handle;
    };

    exports['SetThreadpoolWait'] = () => 0;

    exports['CloseThreadpoolWait'] = (_ctx, _mem, args) => {
        tpWaits.delete(args[0] >>> 0);
        return 0;
    };

    exports['CreateThreadpoolWork'] = (_ctx, _mem, args) => {
        const handle = nextTpHandle++;
        tpWork.set(handle, { callback: args[0] >>> 0, context: args[1] >>> 0 });
        return handle;
    };

    exports['SubmitThreadpoolWork'] = (ctx, _mem, args) => {
        const handle = args[0] >>> 0;
        const entry = tpWork.get(handle);
        if (!entry?.callback) return 0;

        const callbackManager = System.getInstance().process?.dispatcher?.callbackManager;
        if (!callbackManager) return 0;

        const STACK_CLEANUP = 4;
        callbackManager.saveSuspendedThunkContext(ctx, STACK_CLEANUP);
        const { callbackId } = callbackManager.invokeCallback(
            entry.callback,
            [0, entry.context, handle],
            12,
            () => 0,
            false,
            'SubmitThreadpoolWork',
        );

        return { value: 0, suspendedForCallback: true, callbackId, stackCleanup: STACK_CLEANUP };
    };

    exports['CloseThreadpoolWork'] = (_ctx, _mem, args) => {
        tpWork.delete(args[0] >>> 0);
        return 0;
    };

    return exports;
}

export const exports: Record<string, ThunkImplementation> = initVistaRuntime();
