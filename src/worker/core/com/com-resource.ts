/**
 * COM Resource Management - интеграция COM-объектов с SystemResourceProvider
 *
 * Предоставляет высокоуровневые методы для работы с COM-объектами
 * через унифицированную систему ресурсов.
 */

import { BaseComObject } from './base-com-object';
import { SystemResourceProvider, ResourceType } from '../resources/system-resource-provider';
import { Logger, LogCategory } from '../logger';

export class ComResourceManager {
    private resourceProvider = SystemResourceProvider.getInstance();

    /**
     * Create and register a COM object
     */
    createComObject<T extends BaseComObject>(
        ComClass: new (vtableAddress: number, ...args: any[]) => T,
        iid: string,
        vtableAddress: number,
        ...args: any[]
    ): T {
        const obj = new ComClass(vtableAddress, ...args);
        Logger.log(LogCategory.COM, `Created ${ComClass.name} with handle 0x${obj.handle.toString(16)}`);
        return obj;
    }

    /**
     * Get COM object by handle with type safety
     */
    getComObject<T extends BaseComObject>(handle: number): T | null {
        const resource = this.resourceProvider.getResource(handle);
        if (!resource || resource.type !== ResourceType.COM_OBJECT) {
            return null;
        }
        return resource.resource as T;
    }

    /**
     * Check if handle refers to a valid COM object
     */
    isValidComObject(handle: number): boolean {
        const resource = this.resourceProvider.getResource(handle);
        return resource !== null && resource.type === ResourceType.COM_OBJECT;
    }

    /**
     * Add reference to COM object
     */
    addRefComObject(handle: number): number {
        const obj = this.getComObject(handle);
        if (!obj) {
            Logger.error(LogCategory.COM, `AddRef: Invalid COM object handle 0x${handle.toString(16)}`);
            return 0;
        }
        return obj.addRef();
    }

    /**
     * Release reference to COM object
     */
    releaseComObject(handle: number): number {
        const obj = this.getComObject(handle);
        if (!obj) {
            Logger.error(LogCategory.COM, `Release: Invalid COM object handle 0x${handle.toString(16)}`);
            return 0;
        }
        return obj.release();
    }

    /**
     * Query interface on COM object
     */
    queryInterface(handle: number, riid: string, ppvObject: number, memory: Uint8Array): number {
        const obj = this.getComObject(handle);
        if (!obj) {
            Logger.error(LogCategory.COM, `QueryInterface: Invalid COM object handle 0x${handle.toString(16)}`);
            return 0x80004005; // E_FAIL
        }
        return obj.queryInterface(riid, ppvObject, memory);
    }

    /**
     * Get statistics about COM objects
     */
    getStatistics() {
        const stats = this.resourceProvider.getStatistics();
        return {
            comObjects: stats[ResourceType.COM_OBJECT],
            totalResources: stats
        };
    }

    /**
     * Cleanup all COM objects (for shutdown)
     */
    cleanup(): void {
        Logger.log(LogCategory.COM, 'Cleaning up COM resources');
        // COM objects are cleaned up individually via Release()
        // SystemResourceProvider handles the cleanup
    }

    /**
     * Reset COM resource manager - cleanup all resources
     */
    reset(): void {
        Logger.log(LogCategory.COM, 'Resetting COM resources');
        this.resourceProvider.cleanup();
    }
}