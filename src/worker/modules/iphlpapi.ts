import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";

export class Iphlpapi implements IModule {
    name = "iphlpapi";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        // DWORD GetAdaptersInfo(PIP_ADAPTER_INFO pAdapterInfo, PULONG pOutBufLen)
        // Return ERROR_NO_DATA (232) — no network adapters available
        this.exports["GetAdaptersInfo"] = (_ctx, _mem, _args) => {
            return { value: 232, stackCleanup: 8 };
        };
    }
}
