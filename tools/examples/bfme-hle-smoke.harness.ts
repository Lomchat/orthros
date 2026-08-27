import { harness } from '../harness';

const result = await harness()
    .openWgb('/apps/bfme.wgb')
    .call('stopLogs')
    .audioGesture()
    .watchFrames(true)
    .sleep(120_000)
    .perfProfile({ enable: true, reset: true })
    .sleep(3_000)
    .perfStats()
    .call('dbgCall', 'hleReport')
    .faults(20)
    .run();

console.log(JSON.stringify(result, null, 2));
