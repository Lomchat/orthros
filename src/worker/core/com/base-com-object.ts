/**
 * BaseComObject - базовый класс для всех COM-объектов в системе
 *
 * Предоставляет:
 * - Управление reference counting
 * - Базовую реализацию IUnknown методов
 * - Интеграцию с SystemResourceProvider
 * - Типизированную поддержку VTable
 */

import { SystemResourceProvider } from '../resources/system-resource-provider';
import { Logger, LogCategory } from '../logger';
import { System } from '../system';
import { profiler } from '../profiler';

export interface IVTable {
    // VTable methods are implemented via thunk stubs
    // This interface is for TypeScript typing only
}

/**
 * Базовый класс для всех COM-объектов
 */
export abstract class BaseComObject implements IVTable {
    private _refCount: number = 1; // COM objects start with refcount = 1
    private _handle: number = 0;   // Handle in SystemResourceProvider
    private _iid: string;          // Interface ID (GUID)
    private _vtableAddress: number; // Address of VTable in memory

    constructor(iid: string, vtableAddress: number) {
        this._iid = iid;
        this._vtableAddress = vtableAddress;

        // Register in SystemResourceProvider
        const resourceProvider = SystemResourceProvider.getInstance();
        this._handle = resourceProvider.registerComObject(this);
        Logger.verbose(LogCategory.COM, `Created COM object ${this.constructor.name} handle=0x${this._handle.toString(16)} iid=${iid}`);
    }

    /**
     * Get the COM handle (for use in WinAPI calls)
     */
    get handle(): number {
        return this._handle;
    }

    /**
     * Get the VTable address
     */
    get vtableAddress(): number {
        return this._vtableAddress;
    }

    /**
     * Get the Interface ID
     */
    get iid(): string {
        return this._iid;
    }

    /**
     * Get current reference count
     */
    get refCount(): number {
        return this._refCount;
    }

    /**
     * Increment reference count
     */
    addRef(): number {
        this._refCount++;
        Logger.verbose(LogCategory.COM, `${this.constructor.name} AddRef: ${this._refCount} refs`);
        return this._refCount;
    }

    /**
     * Decrement reference count
     */
    release(): number {
        this._refCount--;
        Logger.verbose(LogCategory.COM, `${this.constructor.name} Release: ${this._refCount} refs`);

        if (this._refCount <= 0 && this.leakOnZeroRef) {
            // Some objects (D3D devices in Blade of Darkness) are over-released by the guest's
            // cleanup-on-failure / enumeration churn yet kept in use afterwards. Destroying them
            // here leaves the guest spinning on a dead pointer (`Object not found`) and later
            // corrupts SmartHeap. Keep them registered (a bounded, harmless leak) so the guest's
            // stale pointer keeps resolving. Report 0 to the caller as a real Release would.
            this._refCount = 0;
            Logger.log(LogCategory.COM, `${this.constructor.name} reached 0 refs — kept registered (leak-on-zero-ref guard) handle=0x${this._handle.toString(16)}`);
            return 0;
        }

        if (this._refCount <= 0) {
            const process = System.getInstance().process;
            const cpu = process?.v86?.cpu || (process?.v86?.v86 && process?.v86?.v86.cpu);
            const mem8 = process?.v86?.mem8 || (process?.v86?.v86 && process?.v86?.v86.cpu.mem8);
            if (cpu && mem8) {
                try {
                    const esp = cpu.reg32?.[4] ?? 0;
                    const cs = cpu.sreg?.[1] ?? 0;
                    const eip = cpu.instruction_pointer?.[0] ?? 0;
                    let retAddr = 0;
                    if (esp >= 0 && esp + 4 <= mem8.length) {
                        const view = new DataView(mem8.buffer, mem8.byteOffset, mem8.byteLength);
                        retAddr = view.getUint32(esp, true);
                    }
                    Logger.verbose(LogCategory.COM,
                        `${this.constructor.name} Release stack: CS=0x${cs.toString(16)} EIP=0x${eip.toString(16)} ESP=0x${esp.toString(16)} RET=0x${retAddr.toString(16)}`);
                } catch {}
            }
            Logger.log(LogCategory.COM, `Destroying COM object ${this.constructor.name} handle=0x${this._handle.toString(16)}`);
            // Track COM release for cleanup detection
            System.getInstance().trackComRelease();
            this.destroy();
            SystemResourceProvider.getInstance().unregisterComObject(this._handle);
            return 0;
        }

        return this._refCount;
    }

    /**
     * Query for supported interface
     */
    queryInterface(riid: string, ppvObject: number, memory: Uint8Array): number {
        if (ppvObject === 0 || ppvObject + 4 > memory.length) {
            Logger.warn(LogCategory.COM, `${this.constructor.name} QueryInterface: invalid ppvObject pointer 0x${ppvObject.toString(16)}`);
            return 0x80004003; // E_POINTER
        }

        const view = new DataView(memory.buffer, memory.byteOffset, memory.byteLength);
        const normalizedRiid = this.normalizeIid(riid);
        const normalizedSelf = this.normalizeIid(this._iid);
        const normalizedIUnknown = this.normalizeIid("00000000-0000-0000-C000-000000000046");

        // Check if this is the requested interface or IUnknown
        if (normalizedRiid === normalizedSelf || normalizedRiid === normalizedIUnknown) {
            this.addRef();
            const address = SystemResourceProvider.getInstance().getAddressForHandle(this._handle);
            if (address === null) {
                Logger.error(LogCategory.COM, `${this.constructor.name} QueryInterface ${riid}: object not mapped to guest memory!`);
                view.setUint32(ppvObject, 0, true);
                return 0x80004005; // E_FAIL
            }
            view.setUint32(ppvObject, address >>> 0, true);
            Logger.verbose(LogCategory.COM, `${this.constructor.name} QueryInterface ${riid} -> 0x${address.toString(16)}`);
            return 0; // S_OK
        }

        // Check if derived classes support additional interfaces
        const supportedIid = this.queryAdditionalInterfaces(normalizedRiid);
        if (supportedIid) {
            this.addRef();
            const address = SystemResourceProvider.getInstance().getAddressForHandle(this._handle);
            if (address === null) {
                Logger.error(LogCategory.COM, `${this.constructor.name} QueryInterface ${riid} (additional): object not mapped to guest memory!`);
                view.setUint32(ppvObject, 0, true);
                return 0x80004005; // E_FAIL
            }
            view.setUint32(ppvObject, address >>> 0, true);
            Logger.verbose(LogCategory.COM, `${this.constructor.name} QueryInterface ${riid} -> 0x${address.toString(16)} (additional)`);
            return 0; // S_OK
        }

        // Interface not supported
        view.setUint32(ppvObject, 0, true);
        Logger.verbose(LogCategory.COM, `${this.constructor.name} QueryInterface ${riid} -> E_NOINTERFACE`);
        return 0x80004002; // E_NOINTERFACE
    }

    /**
     * Override in derived classes to support additional interfaces
     */
    protected queryAdditionalInterfaces(riid: string): string | null {
        return null;
    }

    /**
     * When true, the object is NOT destroyed/unregistered when its refcount reaches 0 —
     * it stays registered so a guest that over-releases but keeps using the pointer still
     * resolves. Override to true for objects with that lifetime hazard (D3D devices).
     */
    protected get leakOnZeroRef(): boolean {
        return false;
    }

    /**
     * Force-release this COM object regardless of refcount.
     * Called during shutdown to prevent leaks.
     */
    forceRelease(): void {
        if (this._refCount > 0) {
            Logger.log(LogCategory.COM,
                `Force-releasing ${this.constructor.name} handle=0x${this._handle.toString(16)} (refCount was ${this._refCount})`);
            this._refCount = 0;
            this.destroy();
            SystemResourceProvider.getInstance().unregisterComObject(this._handle);
        }
    }

    /**
     * Called when refcount reaches 0
     */
    protected abstract destroy(): void;

    /**
     * Utility method to check if a pointer is valid
     */
    protected isValidPtr(ptr: number): boolean {
        return ptr !== 0 && ptr !== null && ptr !== undefined;
    }

    private normalizeIid(iid: string): string {
        return iid.replace(/[{}]/g, "").toLowerCase();
    }
}

/**
 * Фабрика для создания COM-объектов
 */
export class ComObjectFactory {
    private static registry: Map<string, ComObjectConstructor> = new Map();

    static register(iid: string, constructor: ComObjectConstructor): void {
        this.registry.set(iid.toLowerCase(), constructor);
        Logger.log(LogCategory.COM, `Registered COM factory for ${iid}`);
    }

    static create<T extends BaseComObject>(
        iid: string,
        vtableAddress: number,
        ...args: any[]
    ): T | null {
        const constructor = this.registry.get(iid.toLowerCase());
        if (!constructor) {
            Logger.error(LogCategory.COM, `No factory registered for IID ${iid}`);
            return null;
        }

        try {
            const instance = new (constructor as any)(vtableAddress, ...args);
            profiler.increment("com_allocations", instance.constructor.name);
            Logger.verbose(LogCategory.COM, `ComObjectFactory.create: Created ${instance.constructor.name} for ${iid} handle=0x${instance.handle.toString(16)} vtable=0x${vtableAddress.toString(16)}`);
            return instance as T;
        } catch (error) {
            Logger.error(LogCategory.COM, `Failed to create COM object for ${iid}: ${error}`);
            return null;
        }
    }

    static getRegisteredIIDs(): string[] {
        return Array.from(this.registry.keys());
    }
}

export type ComObjectConstructor = new (vtableAddress: number, ...args: any[]) => BaseComObject;
