import { harness } from "../harness";

const wgb = "/__wgb/?path=%2Fsrv%2Fbfme%2Fdata%2Fbfme-1.03-fr.wgb";

const result = await harness()
    .reload()
    // Entry of BFME's 3D-provider selection method. Its first stack dword is
    // the return address that later becomes the wild 0x20c036e4 jump.
    .breakOn(0x00aa9910, { continuous: true, pause: true, fast: true })
    .openWgb(wgb, { reload: false })
    .sleep(60_000)
    .call("events", 16)
    .call("cpu")
    .call("readBytes", 0x015140e0, 96)
    .faults(4)
    .run();

console.log(JSON.stringify(result, null, 2));
