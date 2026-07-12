/**
 * A3D Module — minimal COM stub for Aureal A3D 5.0 (covers IA3d through IA3d5).
 *
 * galaxy.dll (Unreal Engine audio) creates an A3D object via CoCreateInstance.
 * It queries IA3d4 but calls IA3d5 methods (e.g. A3dEnumerate at vtable slot 47).
 * All methods are no-op stubs returning S_OK so the game progresses past audio init.
 */

import { IModule } from "../../core/module";
import { Process } from "../../core/process";
import { ThunkImplementation } from "../../core/thunking/thunk-dispatcher";
import { Logger, LogCategory } from "../../core/logger";
import { createVTablesFromDescriptor, VTableInfo } from "../../api/adapters/module-adapter";
import { a3dModule } from "../../api/a3d.api";
import { InterfaceRegistry } from "../../core/com/interface-registry";
import { ComObjectFactory, BaseComObject } from "../../core/com/base-com-object";

const S_OK = 0x00000000;
const E_FAIL = 0x80004005;
const E_NOINTERFACE = 0x80004002;
const IID_IA3D5 = "9ae07221-8ac4-11d3-b6aa-00600879f3ee";

// All known A3D interface IIDs (normalized lowercase, no braces)
const KNOWN_A3D_IIDS = new Set([
    "00000000-0000-0000-c000-000000000046", // IID_IUnknown
    "d8f1eee1-f634-11cf-8700-00a0245d918b", // IID_IA3d
    "fb80d1e0-98d3-11d1-90fb-006008a1f441", // IID_IA3d2
    "c398e560-d90b-11d1-90fb-006008a1f441", // IID_IA3d3
    "e4c40280-ccba-11d2-9dcf-00500411582f", // IID_IA3d4
    "9ae07221-8ac4-11d3-b6aa-00600879f3ee", // IID_IA3d5
]);

class A3dObject extends BaseComObject {
    constructor(vtableAddress: number) {
        super(IID_IA3D5, vtableAddress);
    }

    protected destroy(): void {
        Logger.log(LogCategory.COM, `[A3D] A3dObject destroyed`);
    }
}

export class A3d implements IModule {
    name = "a3d";
    exports: Record<string, ThunkImplementation> = {};
    vtables: Record<string, VTableInfo> = {};
    private process!: Process;

    initialize(process: Process): void {
        this.process = process;

        // Register interface in the registry
        const interfaceRegistry = InterfaceRegistry.getInstance();
        interfaceRegistry.registerFromModuleDescriptor(a3dModule);

        // Create VTables
        this.vtables = createVTablesFromDescriptor(this.process, a3dModule);
        for (const [name, info] of Object.entries(this.vtables)) {
            Logger.verbose(LogCategory.COM, `[A3D] Created vtable ${name} at 0x${info.address.toString(16)} (${info.size} methods)`);
        }

        // Register A3dObject in ComObjectFactory
        ComObjectFactory.register(IID_IA3D5, A3dObject);

        // Register all method stubs
        this.registerIA3d4Exports();
    }

    reset(): void {
        // vtables will be recreated by recreateVTables()
    }

    recreateVTables(): void {
        if (this.process) {
            this.vtables = createVTablesFromDescriptor(this.process, a3dModule);
            for (const [name, info] of Object.entries(this.vtables)) {
                Logger.verbose(LogCategory.COM, `[A3D] Recreated vtable ${name} at 0x${info.address.toString(16)} (${info.size} methods)`);
            }
        }
    }

    private registerIA3d4Exports(): void {
        // IUnknown methods
        this.exports["IA3d5_QueryInterface"] = (_ctx, mem, args) => {
            const thisPtr = args[0] >>> 0;
            const riidPtr = args[1] >>> 0;
            const ppvPtr = args[2] >>> 0;
            const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);

            // Read IID from memory and convert to normalized string
            let iidStr = "unknown";
            if (riidPtr && riidPtr + 16 <= mem.length) {
                const d1 = view.getUint32(riidPtr, true);
                const d2 = view.getUint16(riidPtr + 4, true);
                const d3 = view.getUint16(riidPtr + 6, true);
                const d4 = Array.from(mem.slice(riidPtr + 8, riidPtr + 16))
                    .map(b => b.toString(16).padStart(2, '0')).join('');
                iidStr = `${d1.toString(16).padStart(8, '0')}-${d2.toString(16).padStart(4, '0')}-${d3.toString(16).padStart(4, '0')}-${d4.slice(0, 4)}-${d4.slice(4)}`;
            }

            if (KNOWN_A3D_IIDS.has(iidStr)) {
                // Supported interface — return same object pointer (AddRef)
                if (ppvPtr && ppvPtr + 4 <= mem.length) {
                    view.setUint32(ppvPtr, thisPtr, true);
                }
                Logger.log(LogCategory.COM, `[A3D] QueryInterface(${iidStr}) → S_OK (this=0x${thisPtr.toString(16)})`);
                return S_OK;
            }

            // Unsupported interface — write NULL
            if (ppvPtr && ppvPtr + 4 <= mem.length) {
                view.setUint32(ppvPtr, 0, true);
            }
            Logger.log(LogCategory.COM, `[A3D] QueryInterface(${iidStr}) → E_NOINTERFACE`);
            return E_NOINTERFACE;
        };
        this.exports["IA3d5_AddRef"] = (_ctx, _mem, _args) => 1;
        this.exports["IA3d5_Release"] = (_ctx, _mem, _args) => 0;

        // IA3d methods
        this.exports["IA3d5_SetOutputMode"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_GetOutputMode"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_SetResourceManagerMode"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_GetResourceManagerMode"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_SetHFAbsorbFactor"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_GetHFAbsorbFactor"] = (_ctx, _mem, _args) => S_OK;

        // IA3d2 methods
        this.exports["IA3d5_RegisterVersion"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_GetSoftwareCaps"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_GetHardwareCaps"] = (_ctx, _mem, _args) => S_OK;

        // IA3d3 methods
        this.exports["IA3d5_Clear"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_Flush"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_Compat"] = (_ctx, _mem, _args) => S_OK;

        this.exports["IA3d5_Init"] = (_ctx, _mem, args) => {
            Logger.log(LogCategory.COM, `[A3D] Init(lpGUID=0x${args[1].toString(16)}, features=0x${args[2].toString(16)}, renderPrefs=0x${args[3].toString(16)}) → S_OK (software mode)`);
            return S_OK;
        };

        this.exports["IA3d5_IsFeatureAvailable"] = (_ctx, _mem, _args) => E_FAIL;
        this.exports["IA3d5_NewSource"] = (_ctx, _mem, _args) => E_FAIL;
        this.exports["IA3d5_DuplicateSource"] = (_ctx, _mem, _args) => E_FAIL;

        this.exports["IA3d5_SetCooperativeLevel"] = (_ctx, _mem, args) => {
            Logger.log(LogCategory.COM, `[A3D] IA3d4::SetCooperativeLevel(hwnd=0x${args[1].toString(16)}, level=0x${args[2].toString(16)})`);
            return S_OK;
        };

        this.exports["IA3d5_GetCooperativeLevel"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_SetMaxReflectionDelayTime"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_GetMaxReflectionDelayTime"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_SetCoordinateSystem"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_GetCoordinateSystem"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_SetOutputGain"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_GetOutputGain"] = (_ctx, _mem, _args) => S_OK;

        // IA3d4 methods
        this.exports["IA3d5_SetNumFallbackSources"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_GetNumFallbackSources"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_SetRMPriorityBias"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_GetRMPriorityBias"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_DisableViewer"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_SetUnitsPerMeter"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_GetUnitsPerMeter"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_SetDopplerScale"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_GetDopplerScale"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_SetDistanceModelScale"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_GetDistanceModelScale"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_SetEq"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_GetEq"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_Shutdown"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_RegisterApp"] = (_ctx, _mem, _args) => S_OK;

        // IA3d5 methods (slots 42-50)
        this.exports["IA3d5_InitEx"] = (_ctx, _mem, args) => {
            Logger.log(LogCategory.COM, `[A3D] InitEx(guid=0x${args[1].toString(16)}, flags=0x${args[2].toString(16)}) → S_OK (software mode)`);
            return S_OK;
        };

        this.exports["IA3d5_NewReverb"] = (_ctx, mem, args) => {
            const ppReverb = args[1] >>> 0;
            if (ppReverb && ppReverb + 4 <= mem.length) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(ppReverb, 0, true);
            }
            Logger.log(LogCategory.COM, `[A3D] IA3d5::NewReverb → E_FAIL`);
            return E_FAIL;
        };

        this.exports["IA3d5_BindReverb"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_GetStreamingProperties"] = (_ctx, _mem, _args) => S_OK;
        this.exports["IA3d5_SetStreamingProperties"] = (_ctx, _mem, _args) => S_OK;

        this.exports["IA3d5_A3dEnumerate"] = (_ctx, _mem, args) => {
            Logger.log(LogCategory.COM, `[A3D] IA3d5::A3dEnumerate(callback=0x${args[1].toString(16)}, context=0x${args[2].toString(16)}) → S_OK (no devices)`);
            return S_OK;
        };

        this.exports["IA3d5_UnlockFallbackAC3Decoder"] = (_ctx, _mem, _args) => E_FAIL;

        this.exports["IA3d5_SetMaxHardwareSources"] = (_ctx, _mem, _args) => S_OK;

        this.exports["IA3d5_GetMaxHardwareSources"] = (_ctx, mem, args) => {
            const pCount = args[1] >>> 0;
            if (pCount && pCount + 4 <= mem.length) {
                const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
                view.setUint32(pCount, 0, true);
            }
            return S_OK;
        };
    }
}
