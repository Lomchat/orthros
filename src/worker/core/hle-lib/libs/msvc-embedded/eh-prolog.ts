import { System } from '../../../system';
import { Mem } from '../../../memory/mem-accessor';
import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';
import type { EntryFilterInfo } from '../../types';

export interface MsvcEhPrologTransition {
    returnAddress: number;
    handler: number;
    oldSeh: number;
    oldEbp: number;
    callerEsp: number;
    frame: number;
    wrapperRetSlot: number;
}

function rel32(fromAfterInstruction: number, destination: number): number[] {
    const value = (destination - fromAfterInstruction) | 0;
    return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * The standard HLE stub loads its function id into EAX. `_EH_prolog` receives
 * the exception-handler address in EAX, so preserve that one live input on the
 * guest stack and tail-jump to the stub. The handler deliberately prepares a
 * return slot for the stub's own RET; no extra CALL frame is introduced.
 */
export function assembleMsvcEhPrologWrapper(address: number, stubAddress: number): Uint8Array {
    return Uint8Array.from([
        0x50,                                           // push eax (handler address)
        0xe9, ...rel32(address + 6, stubAddress),       // jmp HLE stub
    ]);
}

export function buildMsvcEhPrologWrapper(info: EntryFilterInfo): number | null {
    const address = info.allocCode(6);
    const code = assembleMsvcEhPrologWrapper(address, info.stubAddress);
    if (address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    info.markNonPreemptible(address, address + code.length);
    return address;
}

/** Compute the complete architectural transition without mutating memory. */
export function computeMsvcEhPrologTransition(
    savedEsp: number,
    oldEbp: number,
    fsBase: number,
    readU32: (address: number) => number | null,
): MsvcEhPrologTransition | null {
    savedEsp >>>= 0;
    oldEbp >>>= 0;
    fsBase >>>= 0;
    if (fsBase === 0) return null;

    const callerEsp = (savedEsp + 4) >>> 0;
    const returnAddress = readU32(callerEsp);
    const handler = readU32(savedEsp);
    const oldSeh = readU32(fsBase);
    if (returnAddress === null || handler === null || oldSeh === null) return null;

    return {
        returnAddress: returnAddress >>> 0,
        handler: handler >>> 0,
        oldSeh: oldSeh >>> 0,
        oldEbp,
        callerEsp,
        frame: (callerEsp - 12) >>> 0,
        wrapperRetSlot: (callerEsp - 16) >>> 0,
    };
}

/** Emergency JS tier. Normal valid calls are completed by WASM handler 84. */
export const msvcEmbeddedEhPrologHandler: ThunkImplementation = () => {
    const process = System.getInstance().process;
    if (!process) return { value: 0, skipStackCheck: true };

    const cpu = process.v86 as any;
    const registers = ((process.dispatcher as any)?.cachedReg32 ?? cpu.reg32) as Int32Array | undefined;
    const fsBase = (cpu.segment_offsets?.[4] ?? 0) >>> 0;
    if (!registers) return { value: 0, skipStackCheck: true };

    const transition = computeMsvcEhPrologTransition(
        registers[4] >>> 0,
        registers[5] >>> 0,
        fsBase,
        address => Mem.readUint32(address),
    );
    if (!transition) return { value: 0, skipStackCheck: true };

    const { wrapperRetSlot, frame, returnAddress, handler, oldSeh, oldEbp, callerEsp } = transition;
    const destinations = [wrapperRetSlot, frame, frame + 4, frame + 8, frame + 12, fsBase]
        .map(address => address >>> 0);
    if (destinations.some(address => Mem.readUint32(address) === null)) {
        return { value: 0, skipStackCheck: true };
    }

    if (!Mem.writeUint32(wrapperRetSlot, returnAddress)
        || !Mem.writeUint32(frame, oldSeh)
        || !Mem.writeUint32(frame + 4, handler)
        || !Mem.writeUint32(frame + 8, 0xffff_ffff)
        || !Mem.writeUint32(frame + 12, oldEbp)
        || !Mem.writeUint32(fsBase, frame)) {
        return { value: 0, skipStackCheck: true };
    }

    // The stub's RET pops wrapperRetSlot, leaving ESP=frame exactly like the
    // original helper's RET. EAX is returned through the dispatcher.
    registers[4] = wrapperRetSlot | 0;
    registers[5] = callerEsp | 0;
    return { value: returnAddress | 0, skipStackCheck: true };
};
