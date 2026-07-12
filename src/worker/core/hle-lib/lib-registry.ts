/**
 * Registry of static-library HLE descriptors.
 *
 * Library modules (libs/<id>/index.ts) call `libRegistry.register(descriptor)`
 * at import time (side-effect imports in emulator.worker.ts). The manager
 * enumerates all registered descriptors when a PE module is loaded.
 */

import type { LibDescriptor } from './types';

class LibRegistry {
    private descriptors = new Map<string, LibDescriptor>();

    register(descriptor: LibDescriptor): void {
        if (this.descriptors.has(descriptor.id)) {
            console.warn(
                `[HLE-lib] Descriptor '${descriptor.id}' already registered — replacing`);
        }
        this.descriptors.set(descriptor.id, descriptor);
    }

    get(id: string): LibDescriptor | undefined {
        return this.descriptors.get(id);
    }

    getAll(): LibDescriptor[] {
        return Array.from(this.descriptors.values());
    }

    clear(): void {
        this.descriptors.clear();
    }
}

export const libRegistry = new LibRegistry();
