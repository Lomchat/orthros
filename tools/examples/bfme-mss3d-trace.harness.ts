import { harness } from "../harness";

const wgb = "/__wgb/?path=%2Fsrv%2Fbfme%2Fdata%2Fbfme-1.03-fr.wgb";

const result = await harness()
    .reload()
    .breakOnApi("mss32:_AIL_get_DirectSound_info@12", { continuous: true })
    .breakOnApi("mss32:_AIL_open_3D_provider@4", { continuous: true })
    .breakOnApi("mss32:_AIL_3D_provider_attribute@12", { continuous: true })
    .breakOnApi("mss32:_AIL_allocate_3D_sample_handle@4", { continuous: true })
    .breakOnApi("mss32:_AIL_set_3D_user_data@12", { continuous: true })
    .breakOnApi("mss32:_AIL_set_3D_rolloff_factor@8", { continuous: true })
    .breakOnApi("mss32:_AIL_open_3D_listener@4", { continuous: true })
    .breakOnApi("mss32:_AIL_set_3D_speaker_type@8", { continuous: true })
    .openWgb(wgb, { reload: false })
    .sleep(35_000)
    .call("events", 512)
    .faults(8)
    .run();

console.log(JSON.stringify(result, null, 2));
