import { harness } from "../harness";

const wgb = "/__wgb/?path=%2Fsrv%2Fbfme%2Fdata%2Fbfme-1.03-fr.wgb";

const result = await harness()
    .reload()
    .breakOnApi("gdi32:CreateDIBSection", { continuous: true })
    .breakOnApi("gdi32:GetObjectA", { continuous: true })
    .breakOnApi("gdiplus:GdipBitmapLockBits", { continuous: true })
    .openWgb(wgb, { reload: false })
    .sleep(8_000)
    .call("events", 100)
    .faults(4)
    .run();

console.log(JSON.stringify(result, null, 2));
