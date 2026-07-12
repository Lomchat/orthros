/**
 * NetAPI32 stub — no NetBIOS/LAN; games fall back to TCP/IP paths.
 */

import { IModule } from "../core/module";
import { Process } from "../core/process";
import { ThunkImplementation } from "../core/thunking/thunk-dispatcher";
import { Mem } from "../core/memory/mem-accessor";

// NRC_ENVNOTDEF — NetBIOS environment not defined (no redirector loaded)
const NRC_ENVNOTDEF = 0x05;

export class Netapi32 implements IModule {
    name = "netapi32";
    exports: Record<string, ThunkImplementation> = {};

    initialize(_process: Process): void {
        // UCHAR NETBIOSAPI Netbios(PNCB pncb)
        this.exports["Netbios"] = (_ctx, _mem, args) => {
            const pncb = args[0] >>> 0;
            if (pncb) Mem.writeUint8(pncb + 1, NRC_ENVNOTDEF); // ncb_retcode
            return NRC_ENVNOTDEF;
        };
    }
}
