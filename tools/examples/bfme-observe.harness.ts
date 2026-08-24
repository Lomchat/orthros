import { harness } from "../harness";

const result = await harness()
    .watchFrames(true)
    .perfProfile({ enable: true, reset: true })
    .sleep(60_000)
    .call("events", 128)
    .state(["cpu", "windows", "surfaces", "audio"])
    .faults(8)
    .report()
    .run();

console.log(JSON.stringify(result, null, 2));
