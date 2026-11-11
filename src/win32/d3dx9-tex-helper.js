// A texture helper worker of D3DX's texture jobs (see d3dx9-tex-jobs.js): its first message carries the guest memory,
// then it runs the jobs it is handed, in order.
import { texHelper } from './d3dx9-tex-jobs.js';
import { GuestMemory } from '../cpu/memory.js';
self.onmessage = ((run) => (e) => run(e.data))(texHelper(GuestMemory));
