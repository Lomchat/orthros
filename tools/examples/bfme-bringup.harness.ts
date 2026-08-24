import { harness } from "../harness";

const bundle = "/__wgb/?path=%2Fsrv%2Fbfme%2Fdata%2Fbfme-1.03-fr.wgb";

const result = await harness()
  .streamLogs(["SYSTEM", "D3D9", "USER32", "MSS32", "DSOUND", "DINPUT", "PE"])
  .openWgb(bundle)
  .audioGesture()
  .watchFrames(true)
  .perfProfile({ enable: true, reset: true })
  .sleep(30_000)
  .perfStats()
  .perfSpikes({ top: 20, minMs: 10 })
  .stubs()
  .report()
  .shot({ save: "/srv/bfme/archive/evaluation-2026-08/bottleship-results/bfme-after-30s.png" })
  .run();

console.log(JSON.stringify(result, null, 2));
