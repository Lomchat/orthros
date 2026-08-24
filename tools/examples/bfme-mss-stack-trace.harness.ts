import { harness } from "../harness";

const wgb = "/__wgb/?path=%2Fsrv%2Fbfme%2Fdata%2Fbfme-1.03-fr.wgb";
const fast = { continuous: true, pause: false, fast: true } as any;

// Sample ESP at every stack-relevant boundary of BFME's audio-provider method.
// All addresses share one 4 KiB page, so the targeted interpreter page-gate
// keeps the rest of boot JIT-fast.
const result = await harness()
    .reload()
    .call("clearBreaks")
    .breakOn(0x00aa9910, fast) // entry
    .breakOn(0x00aa9920, fast) // after initial virtual call
    .breakOn(0x00aa9968, fast) // before AIL_get_DirectSound_info
    .breakOn(0x00aa996e, fast) // after AIL_get_DirectSound_info
    .breakOn(0x00aa99dc, fast) // all callee-saved registers pushed
    .breakOn(0x00aa9b7b, fast) // before selected AIL_open_3D_provider
    .breakOn(0x00aa9b81, fast) // after selected AIL_open_3D_provider
    .breakOn(0x00aa9ba1, fast) // before AIL_set_3D_rolloff_factor
    .breakOn(0x00aa9ba7, fast) // after AIL_set_3D_rolloff_factor
    .breakOn(0x00aa9bda, fast) // before AIL_set_3D_speaker_type
    .breakOn(0x00aa9be0, fast) // after AIL_set_3D_speaker_type
    .breakOn(0x00aa9bf1, fast) // epilogue
    .breakOn(0x00aa9bf4, fast)
    .breakOn(0x00aa9bf5, fast)
    .breakOn(0x00aa9bf8, fast) // RET 4
    .openWgb(wgb, { reload: false })
    .sleep(70_000)
    .call("events", 128)
    .faults(4)
    .run();

console.log(JSON.stringify(result, null, 2));
