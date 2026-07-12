import { Mem } from '../../core/memory/mem-accessor';
import type { LoadedPEModule } from '../../core/module-registry';
import { Logger, LogCategory } from '../../core/logger';
import { resolveExportBodyRva } from './detect';
import type { GalaxyProfile } from './profiles/types';

export interface GalaxyMixerProbe {
    /** Absolute guest address stored in mix-kernel function pointer slot. */
    mixKernelPtr: number;
    /** Absolute guest address stored in convert-kernel function pointer slot. */
    convertKernelPtr: number;
    /** RVA of mix kernel body within Galaxy.dll (null if ptr outside module). */
    mixKernelBodyRva: number | null;
    convertKernelBodyRva: number | null;
    probedAtTick: number;
}

function ptrToBodyRva(module: LoadedPEModule, ptr: number): number | null {
    if (!ptr) return null;
    const base = module.baseAddress;
    if (ptr < base || ptr >= base + module.size) return null;
    return ptr - base;
}

/** Read live mixer kernel pointers from Galaxy .data (valid after native Init). */
export function probeGalaxyMixerKernels(module: LoadedPEModule, profile: GalaxyProfile): GalaxyMixerProbe | null {
    const mixSlot = module.baseAddress + profile.mixer.mixKernelPtrRva;
    const convSlot = module.baseAddress + profile.mixer.convertKernelPtrRva;
    const mixKernelPtr = Mem.readUint32(mixSlot) ?? 0;
    const convertKernelPtr = Mem.readUint32(convSlot) ?? 0;
    if (!mixKernelPtr && !convertKernelPtr) return null;

    const mixBodyRva = ptrToBodyRva(module, mixKernelPtr);
    const convBodyRva = ptrToBodyRva(module, convertKernelPtr);

    const probe: GalaxyMixerProbe = {
        mixKernelPtr,
        convertKernelPtr,
        mixKernelBodyRva: mixBodyRva,
        convertKernelBodyRva: convBodyRva,
        probedAtTick: Date.now(),
    };

    Logger.log(
        LogCategory.SYSTEM,
        `[Galaxy] mixer probe mix=0x${mixKernelPtr.toString(16)}${mixBodyRva != null ? `(rva 0x${mixBodyRva.toString(16)})` : '(ext)'} ` +
            `convert=0x${convertKernelPtr.toString(16)}${convBodyRva != null ? `(rva 0x${convBodyRva.toString(16)})` : '(ext)'}`,
    );
    return probe;
}

/** Resolve export thunk chain for timer callback RVA (diagnostics). */
export function resolveProfileRvaBody(module: LoadedPEModule, rva: number): number {
    return resolveExportBodyRva(module, rva);
}
