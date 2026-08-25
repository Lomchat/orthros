import type { EntryFilterInfo } from '../../types';
import type { ThunkImplementation } from '../../../thunking/thunk-dispatcher';

const POOL_HEADS = 0x0130b1c0;
const POOL_LOCK = 0x0130b254;

type PoolOp = 'alloc' | 'free';

function checkedU32(view: DataView, length: number, address: number): number | null {
    address >>>= 0;
    return address + 4 <= length ? view.getUint32(address, true) >>> 0 : null;
}

/** Test/reference form of BFME's eight-byte-class freelist fast paths. A null
 * result means the original function must run (busy lock, empty class or bad
 * memory). The emitted production wrapper is explicitly registered as a short
 * scheduler non-preemptible range around check→lock→mutation→unlock. */
export function popBfmeSmallPool(
    memory: Uint8Array,
    size: number,
    poolHeads = POOL_HEADS,
    lockAddress = POOL_LOCK,
): number | null {
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    if (checkedU32(view, memory.length, lockAddress) !== 0) return null;
    const headAddress = (poolHeads + (((size - 1) >>> 3) * 4)) >>> 0;
    const head = checkedU32(view, memory.length, headAddress);
    if (!head) return null;
    const next = checkedU32(view, memory.length, head);
    if (next === null) return null;
    view.setUint32(lockAddress, 1, true);
    view.setUint32(headAddress, next, true);
    view.setUint32(lockAddress, 0, true);
    return head;
}

export function pushBfmeSmallPool(
    memory: Uint8Array,
    block: number,
    size: number,
    poolHeads = POOL_HEADS,
    lockAddress = POOL_LOCK,
): boolean {
    const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
    if (!block || checkedU32(view, memory.length, lockAddress) !== 0) return false;
    const headAddress = (poolHeads + (((size - 1) >>> 3) * 4)) >>> 0;
    const head = checkedU32(view, memory.length, headAddress);
    if (head === null || checkedU32(view, memory.length, block) === null) return false;
    view.setUint32(lockAddress, 1, true);
    view.setUint32(block, head, true);
    view.setUint32(headAddress, block, true);
    view.setUint32(lockAddress, 0, true);
    return true;
}

function emitU32(code: number[], value: number): void {
    code.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

/** Complete guest-native replacements for the non-blocking branches at
 * 0x00c2e540/0x00c2e5f0. They retain the original custom lock word but contain
 * no call, OUT or scheduler boundary. Busy/empty allocation cases jump to the
 * relocated original prologue. */
export function assembleBfmeSmallPoolInline(
    op: PoolOp,
    filterAddress: number,
    trampolineAddress: number,
): Uint8Array {
    const code: number[] = [];
    const origRelocations: number[] = [];
    const emit = (...bytes: number[]) => code.push(...bytes);
    const jccOrig = (opcode2: number) => {
        emit(0x0f, opcode2);
        origRelocations.push(code.length);
        emitU32(code, 0);
    };

    // cmp dword ptr [POOL_LOCK],0; jne original
    emit(0x83, 0x3d); emitU32(code, POOL_LOCK); emit(0x00);
    jccOrig(0x85);
    // mov dword ptr [POOL_LOCK],1
    emit(0xc7, 0x05); emitU32(code, POOL_LOCK); emitU32(code, 1);

    // EAX=size; --EAX; EAX>>=3; EDX=&poolHeads[EAX]
    emit(0x8b, 0x44, 0x24, op === 'alloc' ? 0x04 : 0x08);
    emit(0x48, 0xc1, 0xe8, 0x03, 0x8d, 0x14, 0x85); emitU32(code, POOL_HEADS);

    if (op === 'alloc') {
        emit(0x8b, 0x02);             // mov eax,[edx]
        emit(0x85, 0xc0);             // test eax,eax
        const emptyJump = code.length;
        emit(0x0f, 0x84, 0, 0, 0, 0); // jz unlock+original
        emit(0x8b, 0x08, 0x89, 0x0a); // head=*head
        // mov [POOL_LOCK],0; ret
        emit(0xc7, 0x05); emitU32(code, POOL_LOCK); emitU32(code, 0); emit(0xc3);
        const emptyOffset = code.length;
        emit(0xc7, 0x05); emitU32(code, POOL_LOCK); emitU32(code, 0);
        const rel = (filterAddress + emptyOffset - (filterAddress + emptyJump + 6)) | 0;
        for (let i = 0; i < 4; i++) code[emptyJump + 2 + i] = (rel >>> (i * 8)) & 0xff;
    } else {
        emit(0x8b, 0x4c, 0x24, 0x04); // mov ecx,[esp+4] (block)
        emit(0x8b, 0x02, 0x89, 0x01, 0x89, 0x0a); // block->next=*head; *head=block
        emit(0x8b, 0xc2);             // preserve original's useful EAX=&head value
        emit(0xc7, 0x05); emitU32(code, POOL_LOCK); emitU32(code, 0); emit(0xc3);
    }

    const originalJump = code.length;
    emit(0xe9); emitU32(code, 0);
    for (const at of origRelocations) {
        const rel = (filterAddress + originalJump - (filterAddress + at + 4)) | 0;
        for (let i = 0; i < 4; i++) code[at + i] = (rel >>> (i * 8)) & 0xff;
    }
    const originalRel = (trampolineAddress - (filterAddress + originalJump + 5)) | 0;
    for (let i = 0; i < 4; i++) code[originalJump + 1 + i] = (originalRel >>> (i * 8)) & 0xff;
    return Uint8Array.from(code);
}

function build(op: PoolOp, info: EntryFilterInfo): number | null {
    const size = assembleBfmeSmallPoolInline(op, 0x1000, 0x3000).length;
    const address = info.allocCode(size);
    const code = assembleBfmeSmallPoolInline(op, address, info.trampolineAddress);
    if (address <= 0 || address + code.length > info.mem.length) return null;
    info.mem.set(code, address);
    info.markNonPreemptible(address, address + code.length);
    return address;
}

export const buildBfmeSmallPoolAllocInline = (info: EntryFilterInfo) => build('alloc', info);
export const buildBfmeSmallPoolFreeInline = (info: EntryFilterInfo) => build('free', info);

// The generated wrappers never branch to the OUT stub. A registered handler is
// still required by the generic patcher, so keep an intentionally cold guard.
export const bfmeSmallPoolUnreachableHandler: ThunkImplementation = () => 0;
