import { harness } from "../harness";

const bundle = "/__wgb/?path=%2Fsrv%2Fbfme%2Fdata%2Fbfme-1.03-fr.wgb";

const result = await harness()
  .streamLogs(["SYSTEM", "D3D9", "USER32", "GDI32", "MSS32", "DSOUND", "DINPUT", "PE"])
  .openWgb(bundle)
  .audioGesture()
  .watchFrames(true)
  .sleep(8_000)
  .call("events", 30)
  .report()
  .run();

console.log(JSON.stringify(result, null, 2));
